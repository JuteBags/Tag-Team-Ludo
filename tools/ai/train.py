"""Trains the value net (src/engine/ai/net.ts) on self-play shards (tools/ai/selfplay.ts).

    python train.py --shards 'data/*.bin' --out net.json [--inputs hand|raw|all] [--hidden 128]
                    [--margin 0.2] [--wandb <run name> --group <phase>]

A shared trunk turns each colour into a vector; a person's colours are pooled (sum, max, min: with two
houses a person wins only when both are home, and a stranded colour shows in the min) and a small head
scores the person. The loss is Plackett-Luce over the finishing order of the people still playing at
that position, so P(win) = softmax over people. Labels are only the games' real results. Games are
split into train and validation by game, never by position. Prints validation loss next to a uniform
baseline, first-place log-loss, the double-house slice and calibration; writes the weights as JSON for
net.ts plus parity data for parity.ts; with --wandb also logs to W&B and checks parity.
"""
import argparse, glob, json, math, struct, subprocess
import numpy as np
import torch
import torch.nn as nn

F = 19  # hand features (features.ts)
ENTITY, PROJECT = 'shaurya-sharthak', 'tag-team-ludo-ai'
# Bump when the validation protocol changes, so numbers stay comparable across runs.
EVAL_SUITE = 'v1: 5% of games by game id, PL over people, 10-bin calibration'
MODES = [f'{m}{t}' for t in ('', '-singles') for m in ('2p', '3p', '4p', '2h-opposite', '2h-side')]
# Input groups for permutation importance: each hand feature, then the raw blocks and the turn in progress.
HAND = ['pipsLeft', 'base', 'home', 'column', 'danger', 'dangerProg', 'prey', 'preyProg', 'safe', 'blocks',
        'blocking', 'ambush', 'maxProg', 'minProg', 'turn0', 'turn1', 'turn2', 'turn3', 'singles']
GROUPS = [(n, [i]) for i, n in enumerate(HAND)] + [('own-block', list(range(19, 71))), ('enemy-sum', list(range(71, 123))),
                                                   ('enemy-max', list(range(123, 175))), ('tray', list(range(175, 182)))]


def load(path):
    """One shard -> X [P,4,D], owner of each colour [P,4] (-1 for no colour), finishing order of the
    people still playing [P,4] (-1 padded), steps each person had left at the end / 228 [P,4], game ids,
    D, and per position its mode index (MODES) and game phase (0 early, 1 mid, 2 late by turn)."""
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
    mode_g = np.zeros(G, np.int64)
    turns_g = np.ones(G, np.int64)
    for g, x in enumerate(games):
        mode_g[g] = MODES.index(x['mode'])
        turns_g[g] = max(1, x['turns'])
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
    phase = np.minimum(2, (3 * M[:, 1] // turns_g[gi])).astype(np.int64)
    return X[ok], owner[ok], order[ok], left_g[gi][ok], gid[ok], D, mode_g[gi][ok], phase[ok]


class Scorer(nn.Module):
    """The value net, mirroring net.ts. `margin` is a training-only head per colour predicting the steps
    left at the end, summed per person: a denser signal than who won."""

    def __init__(self, inputs, hidden, layers, pool=32):
        super().__init__()
        self.inputs = inputs
        dims = [len(inputs)] + [hidden] * layers
        self.trunk = nn.ModuleList(nn.Linear(a, b) for a, b in zip(dims, dims[1:]))
        self.pool = nn.Linear(3 * hidden, pool)
        self.out = nn.Linear(pool, 1)
        self.margin = nn.Linear(hidden, 1)

    def forward(self, x, owner):
        """x [B,4,D], owner [B,4] -> people's scores [B,4] (0 for nobody) and predicted steps left [B,4]."""
        h = x[..., self.inputs]
        for l in self.trunk:
            h = torch.tanh(l(h))
        m = self.margin(h).squeeze(-1)
        scores, margins = [], []
        for o in range(4):
            mine = owner == o
            k = mine.unsqueeze(-1)
            pooled = torch.cat([(h * k).sum(1), h.masked_fill(~k, -2).amax(1), h.masked_fill(~k, 2).amin(1)], -1)
            sc = self.out(torch.tanh(self.pool(pooled))).squeeze(-1)
            scores.append(torch.where(mine.any(1), sc, torch.zeros_like(sc)))
            margins.append((m * mine).sum(1))
        return torch.stack(scores, 1), torch.stack(margins, 1)


def pl_rows(scores, order):
    """Per position: negative log Plackett-Luce likelihood of `order` (people, -1 padded), and log P(first)."""
    valid = order >= 0
    s = torch.gather(scores, 1, order.clamp(min=0)).masked_fill(~valid, -1e9)
    tail = torch.logcumsumexp(s.flip(1), 1).flip(1)  # log-sum-exp from place k to the end
    use = valid & (torch.arange(4, device=s.device)[None] < valid.sum(1, keepdim=True) - 1)
    return -((s - tail) * use).sum(1), s[:, 0] - tail[:, 0]


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
    ap.add_argument('--wandb', default='', help='W&B run name')
    ap.add_argument('--group', default='phase1-bootstrap')
    a = ap.parse_args()
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    commit = subprocess.run(['git', 'log', '-1', '--format=%h'], capture_output=True, text=True).stdout.strip()
    run = None
    if a.wandb:
        import wandb
        run = wandb.init(entity=ENTITY, project=PROJECT, name=a.wandb, group=a.group, job_type='train',
                         config={**vars(a), 'engine_commit': commit, 'eval_suite': EVAL_SUITE})
        wandb.define_metric('epoch')
        wandb.define_metric('val/*', step_metric='epoch')
        print(f'WANDB {run.url}', flush=True)

    parts = [load(p) for p in sorted(glob.glob(a.shards))]
    D = parts[0][5]
    X, OW, O, L = (torch.from_numpy(np.concatenate([p[k] for p in parts])) for k in range(4))
    G = np.concatenate([p[4] for p in parts])
    MODE = torch.from_numpy(np.concatenate([p[6] for p in parts]))
    PHASE = torch.from_numpy(np.concatenate([p[7] for p in parts]))
    del parts
    val = torch.from_numpy((G % 20) == 0)  # 5% of games
    print(f'POSITIONS {len(X)} train {int((~val).sum())} val {int(val.sum())} D {D}', flush=True)
    if run:
        run.config.update({'positions_train': int((~val).sum()), 'positions_val': int(val.sum()), 'D': D, 'games': len(np.unique(G))})
    Xt, OWt, Ot, Lt = X[~val].to(dev), OW[~val].to(dev), O[~val].to(dev), L[~val].to(dev)
    Xv, OWv, Ov = X[val].to(dev), OW[val].to(dev), O[val].to(dev)
    Mv, PHv = MODE[val], PHASE[val]
    del X

    # A uniform guess over the people still playing: PL loss log(m!), first-place loss log(m).
    mv = (Ov >= 0).sum(1).double()
    base_pl, base_first = torch.lgamma(mv + 1).mean().item(), mv.log().mean().item()
    print(f'BASELINE uniform val {base_pl:.4f} first-logloss {base_first:.4f}', flush=True)
    # Positions with a two-house person, for the double-house loss on its own.
    dh = (torch.stack([(OWv == o).sum(1) for o in range(4)], 1).amax(1) > 1).cpu()

    # hand: the 19 hand features; raw: the token blocks, the turn order and the turn in progress; all: everything.
    inputs = {'hand': list(range(F)), 'raw': list(range(14, 18)) + list(range(F, D)), 'all': list(range(D))}[a.inputs]
    net = Scorer(torch.tensor(inputs, device=dev), a.hidden, a.layers).to(dev)
    if a.init:
        js = json.load(open(a.init))
        for l, j in [*zip(net.trunk, js['trunk']), (net.pool, js['pool']), (net.out, js['out'])]:
            l.weight.data = torch.tensor(j['W'], device=dev, dtype=torch.float32)
            l.bias.data = torch.tensor(j['b'], device=dev, dtype=torch.float32)
    opt = torch.optim.AdamW(net.parameters(), lr=a.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=a.epochs * math.ceil(len(Xt) / a.batch))

    def evaluate():
        net.eval()
        losses, firsts, probs, wins = [], [], [], []
        with torch.no_grad():
            for i in range(0, len(Xv), 65536):
                sc, _ = net(Xv[i:i + 65536], OWv[i:i + 65536])
                o = Ov[i:i + 65536]
                l, lp = pl_rows(sc, o)
                losses.append(l.cpu())
                firsts.append(-lp.cpu())
                live = torch.zeros_like(sc, dtype=torch.bool).scatter_(1, o.clamp(min=0), o >= 0)
                probs.append(torch.softmax(sc.masked_fill(~live, -1e9), 1).masked_fill(~live, -1).cpu())
                wins.append(o[:, 0].cpu())
        net.train()
        loss, first, P, W = torch.cat(losses), torch.cat(firsts), torch.cat(probs), torch.cat(wins)
        won = torch.zeros_like(P)
        won[torch.arange(len(P)), W] = 1
        alive = P >= 0
        brier = (((P - won) ** 2) * alive).sum(1).mean().item()
        by = {f'val/by_mode/{MODES[k]}': loss[Mv == k].mean().item() for k in range(len(MODES)) if (Mv == k).any()}
        by.update({f'val/by_phase/{n}': loss[PHv == k].mean().item() for k, n in enumerate(('early', 'mid', 'late')) if (PHv == k).any()})
        # Calibration over every person still playing: predicted P(win) in 10 bins -> how often they won.
        pr, wr = P[P >= 0], won[P >= 0]
        table = []
        for b in range(10):
            m = (pr >= b / 10) & (pr < (b + 1) / 10)
            if m.sum() > 100:
                table.append([b, pr[m].mean().item(), wr[m].mean().item(), int(m.sum())])
        ece = sum(n * abs(p - w) for _, p, w, n in table) / max(1, sum(n for *_, n in table))
        by['val/brier'] = brier
        by['val/loss_double_house'] = loss[dh].mean().item() if dh.any() else float('nan')
        return loss.mean().item(), first.mean().item(), table, ece, by

    def health():
        """Per trunk layer: weight norm, share of saturated tanh units (|a| > 0.99) and of dead ones (no spread)."""
        out = {}
        with torch.no_grad():
            h = Xv[:20000][..., net.inputs]
            for k, l in enumerate(net.trunk):
                h = torch.tanh(l(h))
                flat = h.reshape(-1, h.shape[-1])
                out[f'learn/weight_norm/trunk{k}'] = l.weight.norm().item()
                out[f'learn/saturated/trunk{k}'] = (flat.abs() > 0.99).float().mean().item()
                out[f'learn/dead/trunk{k}'] = (flat.std(0) < 1e-3).float().mean().item()
            out['learn/weight_norm/pool'] = net.pool.weight.norm().item()
            out['learn/weight_norm/out'] = net.out.weight.norm().item()
        return out

    def importance(n=100_000):
        """Loss increase on validation when one input group is shuffled across positions: what the net relies on."""
        net.eval()
        x, ow, o = Xv[:n], OWv[:n], Ov[:n]
        with torch.no_grad():
            base = pl_rows(net(x, ow)[0], o)[0].mean().item()
            rows = []
            for name, cols in GROUPS:
                if not any(c in set(inputs) for c in cols):
                    continue
                xs = x.clone()
                perm = torch.randperm(len(x), device=x.device)
                xs[:, :, cols] = x[perm][:, :, cols]
                rows.append([name, pl_rows(net(xs, ow)[0], o)[0].mean().item() - base])
        net.train()
        return sorted(rows, key=lambda r: -r[1])

    step = 0
    for ep in range(a.epochs):
        perm = torch.randperm(len(Xt), device=dev)
        for i in range(0, len(Xt), a.batch):
            b = perm[i:i + a.batch]
            sc, mg = net(Xt[b], OWt[b])
            l_pl = pl_rows(sc, Ot[b])[0].mean()
            loss = l_pl
            if a.margin:
                here = torch.stack([(OWt[b] == o).any(1) for o in range(4)], 1)
                l_m = (((mg - Lt[b]) ** 2) * here).sum() / here.sum()
                loss = loss + a.margin * l_m
            opt.zero_grad()
            loss.backward()
            gn = torch.nn.utils.clip_grad_norm_(net.parameters(), 10.0)
            opt.step()
            sched.step()
            step += 1
            if run and step % 50 == 0:
                run.log({'train/loss_pl': l_pl.item(), 'train/loss_margin': l_m.item() if a.margin else 0.0,
                         'train/grad_norm': gn.item(), 'lr': sched.get_last_lr()[0]}, step=step)
        vl, vf, table, ece, by = evaluate()
        vdh = by['val/loss_double_house']
        cal = ' '.join(f'{p:.2f}->{w:.2f}' for _, p, w, _ in table)
        print(f'EPOCH {ep + 1} train {l_pl.item():.4f} val {vl:.4f} first-logloss {vf:.4f} double-house {vdh:.4f} ece {ece:.4f} calib {cal}', flush=True)
        if run:
            run.log({'epoch': ep + 1, 'val/loss_pl': vl, 'val/first_logloss': vf, 'val/baseline_uniform': base_pl,
                     'val/baseline_first': base_first, 'val/gain_vs_uniform': base_pl - vl, 'val/calib_ece': ece,
                     **by, **health()}, step=step)

    dump = lambda l: {'W': l.weight.detach().cpu().double().tolist(), 'b': l.bias.detach().cpu().double().tolist()}
    json.dump({'inputs': inputs, 'trunk': [dump(l) for l in net.trunk], 'pool': dump(net.pool), 'out': dump(net.out)}, open(a.out, 'w'))
    # Parity data for parity.ts: people's scores on 2000 validation positions (NaN for nobody).
    with torch.no_grad():
        x, ow = Xv[:2000], OWv[:2000]
        sc, _ = net(x, ow)
        present = torch.stack([(ow == o).any(1) for o in range(4)], 1)
        sc = sc.double().masked_fill(~present, float('nan'))
    np.save(a.out + '.parity-x.npy', x.cpu().numpy())
    np.save(a.out + '.parity-o.npy', ow.double().cpu().numpy())
    np.save(a.out + '.parity-s.npy', sc.cpu().numpy())
    print(f'SAVED {a.out}', flush=True)
    res = subprocess.run(['node', 'tools/ai/dist/parity.mjs', '--net', a.out], capture_output=True, text=True).stdout
    print(res.strip(), flush=True)
    par = json.loads(res.split('PARITY ', 1)[1]) if 'PARITY ' in res else {'max': float('nan'), 'ok': False}
    if run:
        run.summary.update({'parity/max_abs_diff': par['max'], 'parity/ok': par['ok'], 'val/final_loss_pl': vl, 'val/final_ece': ece})
        cal_t = wandb.Table(columns=['bin', 'mean_pred', 'actual_rate', 'n'], data=table)
        imp = importance()
        print('IMPORTANCE ' + ' '.join(f'{n}:{v:.4f}' for n, v in imp), flush=True)
        imp_t = wandb.Table(columns=['input', 'loss_increase'], data=imp)
        run.log({'val/calibration': cal_t,
                 'val/reliability': wandb.plot.scatter(cal_t, 'mean_pred', 'actual_rate', title='Predicted vs actual P(win)'),
                 'learn/importance': wandb.plot.bar(imp_t, 'input', 'loss_increase', title='Loss increase when an input is shuffled')}, step=step)
        art = wandb.Artifact(a.wandb, type='model', metadata={'engine_commit': commit, 'inputs': a.inputs})
        art.add_file(a.out)
        run.log_artifact(art)
        run.finish(exit_code=0 if par['ok'] else 1)
    if not par['ok']:
        raise SystemExit(f'parity failed: {par}')


if __name__ == '__main__':
    main()
