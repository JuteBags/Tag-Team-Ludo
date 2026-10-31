"""Trains the value net (src/engine/ai/net.ts) on self-play shards (tools/ai/selfplay.ts).

    python train.py --shards 'data/*.bin' --out net.json [--inputs hand|raw|all] [--hidden 128] [--margin 0.2]

A shared MLP scores each colour; a person's score is the sum of their colours' scores (with two houses,
a person wins only when both are home). The loss is Plackett-Luce over the finishing order of the
people still playing at that position, so P(win) = softmax over people. Labels are only the games'
real results. Games are split into train and validation by game, never by position. Prints validation
loss next to a uniform baseline, first-place log-loss and calibration, and writes the weights as JSON
for net.ts (the inputs it reads, then the dense layers) plus parity data for parity.ts.
"""
import argparse, glob, json, math, struct
import numpy as np
import torch
import torch.nn as nn

F = 19  # hand features (features.ts)
RAW = 52  # one colour's raw block (encode.ts)


def load(path):
    """One shard -> X [P,4,D], owner of each colour [P,4] (-1 for no colour), finishing order of the
    people still playing [P,4] (-1 padded), steps each person had left at the end / 228 [P,4], game ids, D."""
    buf = open(path, 'rb').read()
    (hl,) = struct.unpack_from('<I', buf, 0)
    head = json.loads(buf[4:4 + hl])
    D, games = head['D'], head['games']
    off = 4 + hl
    P = (len(buf) - off) // (4 * D * 4 + 16)
    X = np.frombuffer(buf, np.float32, P * 4 * D, off).reshape(P, 4, D)
    M = np.frombuffer(buf, np.int32, P * 4, off + P * 4 * D * 4).reshape(P, 4)
    G = len(games)
    owners_g = np.full((G, 4), -1, np.int64)
    order_g = np.full((G, 4), -1, np.int64)
    left_g = np.zeros((G, 4), np.float32)
    over_g = np.zeros(G, bool)
    for g, x in enumerate(games):
        owners_g[g, :len(x['owners'])] = x['owners']
        order_g[g, :len(x['order'])] = x['order']
        left_g[g, :len(x['left'])] = np.array(x['left'], np.float32) / 228
        over_g[g] = x['over']
    gi = M[:, 0]
    owner = owners_g[gi]
    order = order_g[gi].copy()
    # People already home at this position leave the order; the rest keep their relative order.
    done_c = (X[:, :, 2] > 0.999) | (owner < 0)
    for o in range(4):
        mine = owner == o
        done_o = (done_c | ~mine).all(1) & mine.any(1)
        order[(order == o) & done_o[:, None]] = -1
    order = np.take_along_axis(order, np.argsort(order < 0, axis=1, kind='stable'), 1)
    gid = np.array([hash((head['seed'], int(g))) & 0x7FFFFFFF for g in gi])
    ok = over_g[gi]
    return X[ok], owner[ok], order[ok], left_g[gi][ok], gid[ok], D


class Scorer(nn.Module):
    """Shared MLP per colour. `lin` is the value path (exported); `margin` is a training-only head on
    the last hidden layer predicting the steps left at the end (summed per person), a denser signal."""

    def __init__(self, inputs, hidden, layers):
        super().__init__()
        self.inputs = inputs
        dims = [len(inputs)] + [hidden] * layers + [1]
        self.lin = nn.ModuleList(nn.Linear(a, b) for a, b in zip(dims, dims[1:]))
        self.margin = nn.Linear(hidden, 1)

    def forward(self, x, owner):
        """x [B,4,D], owner [B,4] -> people's scores [B,4] and margins [B,4] (by owner index)."""
        a = x[..., self.inputs]
        for l in self.lin[:-1]:
            a = torch.tanh(l(a))
        s = self.lin[-1](a).squeeze(-1)
        m = self.margin(a).squeeze(-1)
        idx = owner.clamp(min=0) + 4 * (owner < 0)  # missing colours go to a 5th slot that is dropped
        z = torch.zeros(len(x), 5, device=x.device, dtype=s.dtype)
        return z.scatter_add(1, idx, s)[:, :4], z.scatter_add(1, idx, m)[:, :4]


def pl_loss(scores, order):
    """Negative log Plackett-Luce likelihood of `order` (people, -1 padded) under `scores`, and log P(first)."""
    valid = order >= 0
    s = torch.gather(scores, 1, order.clamp(min=0)).masked_fill(~valid, -1e9)
    tail = torch.logcumsumexp(s.flip(1), 1).flip(1)  # log-sum-exp from place k to the end
    m = valid.sum(1, keepdim=True)
    use = valid & (torch.arange(4, device=s.device)[None] < m - 1)
    return -((s - tail) * use).sum(1).mean(), s[:, 0] - tail[:, 0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--shards', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--inputs', default='all', choices=['hand', 'raw', 'all'])
    ap.add_argument('--margin', type=float, default=0.0, help='weight of the steps-left head (0 = off)')
    ap.add_argument('--hidden', type=int, default=128)
    ap.add_argument('--layers', type=int, default=2)
    ap.add_argument('--epochs', type=int, default=6)
    ap.add_argument('--batch', type=int, default=8192)
    ap.add_argument('--lr', type=float, default=2e-3)
    ap.add_argument('--init', default='', help='warm start from a net.json')
    a = ap.parse_args()
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'

    parts = [load(p) for p in sorted(glob.glob(a.shards))]
    D = parts[0][5]
    X, OW, O, L = (torch.from_numpy(np.concatenate([p[k] for p in parts])) for k in range(4))
    G = np.concatenate([p[4] for p in parts])
    del parts
    val = torch.from_numpy((G % 20) == 0)  # 5% of games
    print(f'POSITIONS {len(X)} train {int((~val).sum())} val {int(val.sum())} D {D}', flush=True)
    Xt, OWt, Ot, Lt = X[~val].to(dev), OW[~val].to(dev), O[~val].to(dev), L[~val].to(dev)
    Xv, OWv, Ov = X[val].to(dev), OW[val].to(dev), O[val].to(dev)
    del X

    # A uniform guess over the people still playing: PL loss log(m!), first-place loss log(m).
    mv = (Ov >= 0).sum(1).double()
    print(f'BASELINE uniform val {torch.lgamma(mv + 1).mean():.4f} first-logloss {mv.log().mean():.4f}', flush=True)

    # hand: the 19 hand features; raw: the token blocks, the turn order and the turn in progress; all: everything.
    inputs = {'hand': list(range(F)), 'raw': list(range(14, 18)) + list(range(F, D)), 'all': list(range(D))}[a.inputs]
    net = Scorer(torch.tensor(inputs, device=dev), a.hidden, a.layers).to(dev)
    if a.init:
        for l, j in zip(net.lin, json.load(open(a.init))['layers']):
            l.weight.data = torch.tensor(j['W'], device=dev, dtype=torch.float32)
            l.bias.data = torch.tensor(j['b'], device=dev, dtype=torch.float32)
    opt = torch.optim.AdamW(net.parameters(), lr=a.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=a.epochs * math.ceil(len(Xt) / a.batch))

    def evaluate():
        net.eval()
        tot, first, probs, wins = 0.0, 0.0, [], []
        with torch.no_grad():
            for i in range(0, len(Xv), 65536):
                sc, _ = net(Xv[i:i + 65536], OWv[i:i + 65536])
                o = Ov[i:i + 65536]
                l, lp = pl_loss(sc, o)
                tot += l.item() * len(sc)
                first += -lp.sum().item()
                live = torch.zeros_like(sc, dtype=torch.bool).scatter_(1, o.clamp(min=0), o >= 0)
                probs.append(torch.softmax(sc.masked_fill(~live, -1e9), 1).masked_fill(~live, -1).cpu())
                wins.append(o[:, 0].cpu())
        net.train()
        P, W = torch.cat(probs), torch.cat(wins)
        won = torch.zeros_like(P)
        won[torch.arange(len(P)), W] = 1
        # Calibration over every person still playing: predicted P(win) in 10 bins -> how often they won.
        pr, wr = P[P >= 0], won[P >= 0]
        bins = [f'{pr[m].mean():.2f}->{wr[m].mean():.2f}' for b in range(10) if (m := (pr >= b / 10) & (pr < (b + 1) / 10)).sum() > 100]
        return tot / len(Xv), first / len(Xv), ' '.join(bins)

    for ep in range(a.epochs):
        perm = torch.randperm(len(Xt), device=dev)
        for i in range(0, len(Xt), a.batch):
            b = perm[i:i + a.batch]
            sc, mg = net(Xt[b], OWt[b])
            loss, _ = pl_loss(sc, Ot[b])
            if a.margin:
                here = torch.zeros_like(sc, dtype=torch.bool).scatter_(1, OWt[b].clamp(min=0), OWt[b] >= 0)
                loss = loss + a.margin * (((mg - Lt[b]) ** 2) * here).sum() / here.sum()
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
        vl, vf, cal = evaluate()
        print(f'EPOCH {ep + 1} train {loss.item():.4f} val {vl:.4f} first-logloss {vf:.4f} calib {cal}', flush=True)

    json.dump({'inputs': inputs, 'layers': [{'W': l.weight.detach().cpu().double().tolist(), 'b': l.bias.detach().cpu().double().tolist()} for l in net.lin]}, open(a.out, 'w'))
    # Parity data for parity.ts: per-colour scores of 2000 validation positions.
    with torch.no_grad():
        x = Xv[:2000]
        h = x[..., net.inputs]
        for l in net.lin[:-1]:
            h = torch.tanh(l(h))
        sc = net.lin[-1](h).squeeze(-1)
    np.save(a.out + '.parity-x.npy', x.cpu().numpy())
    np.save(a.out + '.parity-s.npy', sc.double().cpu().numpy())
    print(f'SAVED {a.out}', flush=True)


if __name__ == '__main__':
    main()
