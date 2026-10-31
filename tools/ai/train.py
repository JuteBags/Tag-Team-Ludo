"""Trains the value net (src/engine/ai/net.ts) on self-play shards (tools/ai/selfplay.ts).

    python train.py --shards 'data/*.bin' --out net.json [--inputs hand|raw|all] [--hidden 128] [--margin 0.2]

Each colour gets a score from a shared MLP; the loss is Plackett-Luce over the finishing order of the
colours still playing at that position, so P(first) = softmax(scores). Games are split into train and
validation by game, never by position. Prints validation loss, first-place log-loss and calibration,
and writes the weights as JSON for net.ts (the inputs it reads, then the dense layers).
"""
import argparse, glob, json, math, struct
import numpy as np
import torch
import torch.nn as nn

F = 19  # hand features (features.ts); the rest of D is the raw block (encode.ts)


def load(path):
    """One shard -> X [P,4,D], finishing order of the colours still playing [P,4] (-1 padded), steps
    each colour had left at the end / 228 [P,4], game ids, D."""
    buf = open(path, 'rb').read()
    (hl,) = struct.unpack_from('<I', buf, 0)
    head = json.loads(buf[4:4 + hl])
    D = head['D']
    games = head['games']
    off = 4 + hl
    rest = len(buf) - off
    P = rest // (4 * D * 4 + 16)
    X = np.frombuffer(buf, np.float32, P * 4 * D, off).reshape(P, 4, D)
    M = np.frombuffer(buf, np.int32, P * 4, off + P * 4 * D * 4).reshape(P, 4)
    order = np.full((P, 4), -1, np.int64)
    left = np.zeros((P, 4), np.float32)
    for i, (g, _turn, n, _cur) in enumerate(M):
        left[i, :n] = np.array(games[g].get('left', [0] * n), np.float32) / 228
        o = [c for c in games[g]['order'] if X[i, c, 2] < 0.999]  # colours already home are out
        order[i, :len(o)] = o
    gid = np.array([hash((head['seed'], int(g))) & 0x7FFFFFFF for g in M[:, 0]])
    ok = np.array([games[g]['over'] for g in M[:, 0]])
    return X[ok], order[ok], left[ok], gid[ok], D


class Scorer(nn.Module):
    """Shared MLP per colour. `lin` is the value path (exported); `margin` is a training-only head on
    the last hidden layer that predicts the steps left at the end, a denser signal than who won."""

    def __init__(self, inputs, hidden, layers):
        super().__init__()
        self.inputs = inputs
        dims = [len(inputs)] + [hidden] * layers + [1]
        self.lin = nn.ModuleList(nn.Linear(a, b) for a, b in zip(dims, dims[1:]))
        self.margin = nn.Linear(hidden, 1)

    def forward(self, x, with_margin=False):  # x: [B,4,D] -> scores [B,4] (and margins [B,4])
        a = x[..., self.inputs]
        for l in self.lin[:-1]:
            a = torch.tanh(l(a))
        s = self.lin[-1](a).squeeze(-1)
        return (s, self.margin(a).squeeze(-1)) if with_margin else s


def pl_loss(scores, order):
    """Negative log Plackett-Luce likelihood of `order` (colour indices, -1 padded) under `scores`."""
    valid = order >= 0
    s = torch.gather(scores, 1, order.clamp(min=0)).masked_fill(~valid, -1e9)
    # log-sum-exp of the scores from place k to the end
    tail = torch.logcumsumexp(s.flip(1), 1).flip(1)
    m = valid.sum(1, keepdim=True)
    k = torch.arange(4, device=s.device).unsqueeze(0)
    use = valid & (k < m - 1)
    return -((s - tail) * use).sum(1).mean(), (s[:, 0] - tail[:, 0])  # loss, log P(first)


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
    D = parts[0][4]
    X = torch.from_numpy(np.concatenate([p[0] for p in parts]))
    O = torch.from_numpy(np.concatenate([p[1] for p in parts]))
    L = torch.from_numpy(np.concatenate([p[2] for p in parts]))
    G = np.concatenate([p[3] for p in parts])
    del parts
    val = torch.from_numpy((G % 20) == 0)  # 5% of games
    print(f'POSITIONS {len(X)} train {int((~val).sum())} val {int(val.sum())} D {D}', flush=True)
    Xt, Ot, Lt, Xv, Ov = X[~val].to(dev), O[~val].to(dev), L[~val].to(dev), X[val].to(dev), O[val].to(dev)
    del X

    # hand: the 19 hand features; raw: the token blocks plus the turn order; all: everything.
    inputs = {'hand': list(range(F)), 'raw': list(range(14, 18)) + list(range(F, D)), 'all': list(range(D))}[a.inputs]
    net = Scorer(torch.tensor(inputs, device=dev), a.hidden, a.layers).to(dev)
    if a.init:
        js = json.load(open(a.init))
        for l, j in zip(net.lin, js['layers']):
            l.weight.data = torch.tensor(j['W'], device=dev)
            l.bias.data = torch.tensor(j['b'], device=dev)
    opt = torch.optim.AdamW(net.parameters(), lr=a.lr, weight_decay=1e-4)
    steps = a.epochs * math.ceil(len(Xt) / a.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=steps)

    def evaluate():
        net.eval()
        with torch.no_grad():
            tot, first, probs, wins = 0.0, 0.0, [], []
            for i in range(0, len(Xv), 65536):
                sc = net(Xv[i:i + 65536])
                l, lp = pl_loss(sc, Ov[i:i + 65536])
                tot += l.item() * len(sc)
                first += -lp.sum().item()
                # P(first) over the colours still playing (the ones listed in the order).
                live = torch.zeros_like(sc, dtype=torch.bool).scatter_(1, Ov[i:i + 65536].clamp(min=0), Ov[i:i + 65536] >= 0)
                probs.append(torch.softmax(sc.masked_fill(~live, -1e9), 1).cpu())
                wins.append(Ov[i:i + 65536, 0].cpu())
        net.train()
        n = len(Xv)
        P = torch.cat(probs)
        W = torch.cat(wins)
        # Calibration over every live colour: predicted P(first) in 10 bins vs how often it came first.
        isw = torch.zeros_like(P)
        isw[torch.arange(n), W] = 1
        alive = torch.zeros_like(P, dtype=torch.bool)
        for k in range(4):
            idx = Ov.cpu()[:, k]
            ok = idx >= 0
            alive[torch.arange(n)[ok], idx[ok]] = True
        pr, iw = P[alive], isw[alive]
        bins = []
        for b in range(10):
            m = (pr >= b / 10) & (pr < (b + 1) / 10)
            if m.sum() > 100:
                bins.append(f'{pr[m].mean():.2f}->{iw[m].mean():.2f}')
        return tot / n, first / n, ' '.join(bins)

    step = 0
    for ep in range(a.epochs):
        perm = torch.randperm(len(Xt), device=dev)
        for i in range(0, len(Xt), a.batch):
            b = perm[i:i + a.batch]
            sc, mg = net(Xt[b], with_margin=True)
            loss, _ = pl_loss(sc, Ot[b])
            if a.margin:
                # Colours at the table have a turn-order flag set (padding colours are all zeros).
                live = Xt[b, :, 14:18].sum(-1) > 0
                loss = loss + a.margin * ((mg - Lt[b]) ** 2 * live).sum() / live.sum()
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            step += 1
        vl, vf, cal = evaluate()
        print(f'EPOCH {ep + 1} train {loss.item():.4f} val {vl:.4f} first-logloss {vf:.4f} calib {cal}', flush=True)

    js = {'inputs': inputs, 'layers': [{'W': l.weight.detach().cpu().double().tolist(), 'b': l.bias.detach().cpu().double().tolist()} for l in net.lin]}
    json.dump(js, open(a.out, 'w'))
    # Parity check data: scores of the first 2000 validation positions, for parity.mjs.
    with torch.no_grad():
        sc = net(Xv[:2000]).double().cpu().numpy()
    np.save(a.out + '.parity-x.npy', Xv[:2000].cpu().numpy())
    np.save(a.out + '.parity-s.npy', sc)
    print(f'SAVED {a.out}', flush=True)


if __name__ == '__main__':
    main()
