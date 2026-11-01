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

Residual mode (--rules <linear rules json> --alpha a): a person's score is net(x) + a * rules(x), where
rules(x) is the frozen readable rules (linear.ts ownerScores: the hand features of the person's colours
plus the turn rules, from the same inputs as --linear) and the loss runs on that sum; the net learns
what the rules miss. The saved JSON is the net alone; play it as blend:<net>:<rules>:<a> (blend.ts).
Parity: the net against net.ts as always, and the rules part against linear.ts on the same positions,
so the blend (their sum, as blend.ts adds them) is checked through both.
"""
import argparse, glob, json, math, os, struct, subprocess
import numpy as np
import torch
import torch.nn as nn

F = 19  # hand features (features.ts)
# W&B: the account's only entity is a team; LUDO_WANDB_ENTITY moves runs elsewhere (e.g. a Ludo team).
TURN_RULES = ['tray1', 'tray2', 'tray3', 'tray4', 'tray5', 'tray6', 'sixes']  # linear.ts
ENTITY = os.environ.get('LUDO_WANDB_ENTITY', 'ablations-tinycompany-ai')
PROJECT = 'tag-team-ludo-ai'
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
    # Turns left in the game from this position, / 500 (an auxiliary target: how far from the end).
    tleft = ((turns_g[gi] - M[:, 1]) / 500).astype(np.float32)
    return X[ok], owner[ok], order[ok], left_g[gi][ok], gid[ok], D, mode_g[gi][ok], phase[ok], ok, tleft[ok]


def load_expert(path):
    """A ludo-expert file: per decision group, every candidate's resulting position and its paired playout
    mean for the mover. Returns X [R,4,D], owner [R,4], group [R] (file-local), mover [R], mean [R]."""
    buf = open(path, 'rb').read()
    (hl,) = struct.unpack_from('<I', buf, 0)
    head = json.loads(buf[4:4 + hl])
    assert head.get('kind') == 'expert', f'{path} is not a ludo-expert file'
    D, R = head['D'], head['rows']
    off = 4 + hl
    X = np.frombuffer(buf, np.float32, R * 4 * D, off).reshape(R, 4, D)
    off += R * 4 * D * 4
    OW = np.frombuffer(buf, np.int32, R * 4, off).reshape(R, 4).astype(np.int64)
    off += R * 4 * 4
    GR = np.frombuffer(buf, np.int32, R, off).astype(np.int64)
    MV = np.frombuffer(buf, np.int32, R, off + 4 * R).astype(np.int64)
    MN = np.frombuffer(buf, np.float32, R, off + 8 * R)
    return X, OW, GR, MV, MN


def load_targets(path, ok):
    """ludo-label's sidecar for a shard: per position, each person's target chance of finishing first next
    (a lambda-return along the real game, by owner index), rows in shard order."""
    buf = open(path, 'rb').read()
    (hl,) = struct.unpack_from('<I', buf, 0)
    head = json.loads(buf[4:4 + hl])
    T = np.frombuffer(buf, np.float32, head['positions'] * 4, 4 + hl).reshape(-1, 4)
    assert len(T) == len(ok), f'{path}: {len(T)} target rows for {len(ok)} positions'
    return T[ok]


class Scorer(nn.Module):
    """The value net, mirroring net.ts. `margin` is a training-only head per colour predicting the steps
    left at the end, summed per person: a denser signal than who won."""

    def __init__(self, inputs, hidden, layers, pool=32, linear=False):
        super().__init__()
        self.inputs = inputs
        # linear: readable rules (linear.ts), a person's score = weights . (sum of their colours' features).
        self.linear = nn.Linear(len(inputs), 1, bias=False) if linear else None
        dims = [len(inputs)] + [hidden] * layers
        self.trunk = nn.ModuleList(nn.Linear(a, b) for a, b in zip(dims, dims[1:]))
        self.pool = nn.Linear(3 * hidden, pool)
        self.out = nn.Linear(pool, 1)
        self.margin = nn.Linear(hidden, 1)
        # Training-only: turns left in the game, from the mean of the colours' trunk vectors.
        self.turns = nn.Linear(hidden, 1)
        self.last_turns = None

    def forward(self, x, owner):
        """x [B,4,D], owner [B,4] -> people's scores [B,4] (0 for nobody) and predicted steps left [B,4]."""
        if self.linear is not None:
            c = self.linear(x[..., self.inputs]).squeeze(-1)
            sc = torch.stack([(c * (owner == o)).sum(1) for o in range(4)], 1)
            return sc, torch.zeros_like(sc)
        h = x[..., self.inputs]
        for l in self.trunk:
            h = torch.tanh(l(h))
        m = self.margin(h).squeeze(-1)
        present = (owner >= 0).unsqueeze(-1)
        self.last_turns = self.turns((h * present).sum(1) / present.sum(1).clamp(min=1)).squeeze(-1)
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
    ap.add_argument('--aux-turns', type=float, default=0.0, help='weight of the turns-left head (0 = off)')
    ap.add_argument('--linear', action='store_true', help='fit readable linear rules on the hand features (linear.ts)')
    ap.add_argument('--hidden', type=int, default=128)
    ap.add_argument('--layers', type=int, default=2)
    ap.add_argument('--epochs', type=int, default=6)
    ap.add_argument('--batch', type=int, default=8192)
    ap.add_argument('--lr', type=float, default=2e-3)
    ap.add_argument('--init', default='', help='warm start from a net.json')
    ap.add_argument('--target', default='outcome', help="outcome (PL on the real finishing order) or lambda (ludo-label's <shard>.targets)")
    ap.add_argument('--pl-weight', type=float, default=0.0, help='with --target lambda, also this much PL on the real order')
    ap.add_argument('--wandb', default='', help='W&B run name')
    ap.add_argument('--group', default='phase1-bootstrap')
    ap.add_argument('--max-games', type=int, default=0, help='train on only the first shards, up to about this many games')
    ap.add_argument('--expert', default='', help='ludo-expert files (comma-separated globs): paired move comparisons, '
                    'trained with the centred pair loss (each group: net values minus their mean vs playout means minus theirs)')
    ap.add_argument('--expert-weight', type=float, default=1.0, help='weight of the (normalised) pair loss next to the PL on --shards')
    ap.add_argument('--expert-groups', type=int, default=2048, help='decision groups per step for the pair loss')
    ap.add_argument('--rules', default='', help='residual mode: frozen linear rules json added to the net score')
    ap.add_argument('--alpha', type=float, default=0.0, help='residual mode: weight of --rules in the score (blend.ts alpha)')
    ap.add_argument('--learn-temp', action='store_true', help='also learn one temperature tau on the whole score; at export it is folded into '
                    "the net's out layer and alpha becomes tau * alpha (printed on the BLEND line)")
    a = ap.parse_args()
    assert not (a.rules and a.linear), '--rules is for training a net as a residual over readable rules'
    assert bool(a.rules) == (a.alpha != 0), '--rules and --alpha go together'
    assert not (a.learn_temp and a.linear), '--learn-temp scales a net (its out layer)'
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

    # --shards: glob patterns separated by commas; --max-games keeps whole shards until about that many games.
    paths = sorted({p for pat in a.shards.split(',') for p in glob.glob(pat)})
    parts = []
    for path in paths:
        if a.max_games and sum(len(np.unique(q[4])) for q in parts) >= a.max_games:
            break
        part = load(path)
        if a.target == 'lambda':
            part = (*part, load_targets(path + '.targets', part[8]))
        parts.append(part)
    print(f'SHARDS {len(parts)} of {len(paths)}', flush=True)
    D = parts[0][5]
    X, OW, O, L = (torch.from_numpy(np.concatenate([p[k] for p in parts])) for k in range(4))
    TG = torch.from_numpy(np.concatenate([p[10] for p in parts])) if a.target == 'lambda' else None
    TL = torch.from_numpy(np.concatenate([p[9] for p in parts]))
    G = np.concatenate([p[4] for p in parts])
    MODE = torch.from_numpy(np.concatenate([p[6] for p in parts]))
    PHASE = torch.from_numpy(np.concatenate([p[7] for p in parts]))
    del parts
    val = torch.from_numpy((G % 20) == 0)  # 5% of games
    print(f'POSITIONS {len(X)} train {int((~val).sum())} val {int(val.sum())} D {D}', flush=True)
    if run:
        run.config.update({'positions_train': int((~val).sum()), 'positions_val': int(val.sum()), 'D': D, 'games': len(np.unique(G))})
    Xt, OWt, Ot, Lt = X[~val].to(dev), OW[~val].to(dev), O[~val].to(dev), L[~val].to(dev)
    TGt = TG[~val].to(dev) if TG is not None else None
    TLt = TL[~val].to(dev)
    Xv, OWv, Ov = X[val].to(dev), OW[val].to(dev), O[val].to(dev)
    # Expert data (--expert): rows grouped by decision; 5% of the groups held out.
    EX = None
    if a.expert:
        eparts, gofs = [], 0
        for path in sorted({q for pat in a.expert.split(',') for q in glob.glob(pat)}):
            ex, eo, eg, em, en = load_expert(path)
            eparts.append((ex, eo, eg + gofs, em, en))
            gofs += int(eg.max()) + 1 if len(eg) else 0
        EXx = torch.from_numpy(np.concatenate([q[0] for q in eparts])).to(dev)
        EXo = torch.from_numpy(np.concatenate([q[1] for q in eparts])).to(dev)
        EXg = torch.from_numpy(np.concatenate([q[2] for q in eparts])).to(dev)
        EXm = torch.from_numpy(np.concatenate([q[3] for q in eparts])).to(dev)
        EXr = torch.from_numpy(np.concatenate([q[4] for q in eparts])).to(dev)
        del eparts
        G = int(EXg.max()) + 1
        counts = torch.bincount(EXg, minlength=G)
        starts = torch.cumsum(counts, 0) - counts
        # centred playout means, and their mean square (the loss is divided by it: dimensionless, about 1 = no skill)
        gmean_r = torch.zeros(G, device=dev).scatter_add_(0, EXg, EXr) / counts.clamp(min=1)
        rc = EXr - gmean_r[EXg]
        r_scale = (rc ** 2).mean().clamp(min=1e-8)
        gval = (torch.arange(G, device=dev) % 20) == 0
        EX = dict(x=EXx, o=EXo, g=EXg, m=EXm, rc=rc, counts=counts, starts=starts, G=G, gval=gval, scale=r_scale)
        print(f'EXPERT rows {len(EXg)} groups {G} rc_rms {r_scale.sqrt().item():.4f}', flush=True)
        if run:
            run.config.update({'expert_n_rows': len(EXg), 'expert_n_groups': G})

    def expert_rows(gids):
        """Row indexes of the given decision groups (contiguous in the files)."""
        c = EX['counts'][gids]
        first = EX['starts'][gids]
        rep_first = torch.repeat_interleave(first, c)
        within = torch.arange(int(c.sum()), device=dev) - torch.repeat_interleave(torch.cumsum(c, 0) - c, c)
        return rep_first + within

    def pair_loss(gids, train=True):
        """Centred pair loss on these groups (normalised), and the share of groups where the net's top candidate
        is the playouts' top candidate."""
        rows = expert_rows(gids)
        x, ow, g, mv, rc = EX['x'][rows], EX['o'][rows], EX['g'][rows], EX['m'][rows], EX['rc'][rows]
        sc, _ = score(x, ow)
        # people still playing: any colour not home (encode.ts feature 2 = share of tokens home)
        done_c = (x[:, :, 2] > 0.999) | (ow < 0)
        live = torch.stack([((ow == o) & ~done_c).any(1) for o in range(4)], 1)
        p = torch.softmax(sc.masked_fill(~live, -1e9), 1).gather(1, mv[:, None]).squeeze(1)
        # group ids local to this batch
        _, lg = torch.unique(g, return_inverse=True)
        ng = int(lg.max()) + 1
        cnt = torch.zeros(ng, device=dev).scatter_add_(0, lg, torch.ones_like(p))
        vc = p - (torch.zeros(ng, device=dev).scatter_add_(0, lg, p) / cnt)[lg]
        loss = ((vc - rc) ** 2).mean() / EX['scale']
        with torch.no_grad():
            neg = torch.full((ng,), -1e9, device=dev)
            top_v = neg.scatter_reduce(0, lg, vc, 'amax')
            top_r = neg.scatter_reduce(0, lg, rc, 'amax')
            hit_v = (vc >= top_v[lg] - 1e-12) & (rc >= top_r[lg] - 1e-12)
            agree = torch.zeros(ng, device=dev).scatter_add_(0, lg, hit_v.float()).clamp(max=1).mean()
        return loss, agree

    def expert_val():
        net.eval()
        vg = torch.nonzero(EX['gval']).squeeze(1)
        ls, ag = [], []
        with torch.no_grad():
            for i in range(0, len(vg), 8192):
                l, g_ = pair_loss(vg[i:i + 8192])
                ls.append(l.item())
                ag.append(g_.item())
        net.train()
        return sum(ls) / len(ls), sum(ag) / len(ag)
    Mv, PHv = MODE[val], PHASE[val]
    del X

    # A uniform guess over the people still playing: PL loss log(m!), first-place loss log(m).
    mv = (Ov >= 0).sum(1).double()
    base_pl, base_first = torch.lgamma(mv + 1).mean().item(), mv.log().mean().item()
    print(f'BASELINE uniform val {base_pl:.4f} first-logloss {base_first:.4f}', flush=True)
    # Positions with a two-house person, for the double-house loss on its own.
    dh = (torch.stack([(OWv == o).sum(1) for o in range(4)], 1).amax(1) > 1).cpu()
    rule_name = lambda i: HAND[i] if i < F else TURN_RULES[i - (D - 7)]

    # hand: the 19 hand features; raw: the token blocks, the turn order and the turn in progress; all: everything.
    inputs = {'hand': list(range(F)), 'raw': list(range(14, 18)) + list(range(F, D)), 'all': list(range(D))}[a.inputs]
    if a.linear:
        # 'singles' is the same for every person in a game, so it cancels in the softmax and its weight
        # would only drift: readable rules leave it out. The turn in progress (encode.ts's last 7 inputs,
        # set only for the colour about to roll) joins as the tray rules (linear.ts TURN_RULES).
        inputs = [i for i in range(F) if HAND[i] != 'singles'] + list(range(D - 7, D))
    if a.init:
        js = json.load(open(a.init))
        # A warm start keeps the starting net's shape and inputs.
        a.hidden, a.layers, inputs = len(js['trunk'][0]['b']), len(js['trunk']), js['inputs']
    net = Scorer(torch.tensor(inputs, device=dev), a.hidden, a.layers, linear=a.linear).to(dev)
    # Residual mode: the frozen rules as one weight per input (hand features, then the 7 turn rules at the
    # end of the encoding; a rule the json does not name gets 0), summed over a person's colours.
    rules_w = None
    if a.rules:
        rj = json.load(open(a.rules))
        assert rj.get('kind') == 'linear', f'{a.rules} is not readable rules'
        wv = torch.zeros(D, dtype=torch.float64)
        for i in range(F):
            wv[i] = rj['weights'].get(HAND[i], 0.0)  # as linear.ts / parity.ts: a missing rule is 0
        for j, name in enumerate(TURN_RULES):
            wv[D - 7 + j] = rj['weights'].get(name, 0.0)
        rules_w = wv

    def rules_scores(x, ow, dtype=torch.float32):
        c = x.to(dtype) @ rules_w.to(x.device, dtype)
        return torch.stack([(c * (ow == o)).sum(1) for o in range(4)], 1)

    # --learn-temp: score * exp(log_tau), one scalar (the rules are tuned to pick moves, not to be calibrated)
    log_tau = torch.zeros((), device=dev, requires_grad=a.learn_temp)

    def score(x, ow):
        """The training score: the net's, plus alpha times the frozen rules' in residual mode, times tau."""
        sc, mg = net(x, ow)
        if rules_w is not None:
            sc = sc + a.alpha * rules_scores(x, ow)
        if a.learn_temp:
            sc = sc * log_tau.exp()
        return sc, mg
    if a.init:
        for l, j in [*zip(net.trunk, js['trunk']), (net.pool, js['pool']), (net.out, js['out'])]:
            l.weight.data = torch.tensor(j['W'], device=dev, dtype=torch.float32)
            l.bias.data = torch.tensor(j['b'], device=dev, dtype=torch.float32)
    if a.learn_temp:
        # Fit tau alone first (net frozen; a scalar needs far more than a few steps at the net's rate), then
        # train it with the net in its own group at a higher rate.
        opt_t = torch.optim.Adam([log_tau], lr=0.05)
        n_fit = min(len(Xt), 65536)
        for _ in range(300):
            b = torch.randint(0, len(Xt), (n_fit,), device=dev)
            with torch.no_grad():
                base_sc, _ = net(Xt[b], OWt[b])
                if rules_w is not None:
                    base_sc = base_sc + a.alpha * rules_scores(Xt[b], OWt[b])
            l_t = pl_rows(base_sc * log_tau.exp(), Ot[b])[0].mean()
            opt_t.zero_grad()
            l_t.backward()
            opt_t.step()
        print(f'TEMP fit tau {log_tau.exp().item():.4f} (net frozen)', flush=True)
    groups = [{'params': list(net.parameters()), 'lr': a.lr, 'weight_decay': 1e-4}]
    if a.learn_temp:
        groups.append({'params': [log_tau], 'lr': 10 * a.lr, 'weight_decay': 0.0})
    opt = torch.optim.AdamW(groups)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=[g['lr'] for g in groups], total_steps=a.epochs * math.ceil(len(Xt) / a.batch))

    def evaluate():
        net.eval()
        losses, firsts, probs, wins = [], [], [], []
        with torch.no_grad():
            for i in range(0, len(Xv), 65536):
                sc, _ = score(Xv[i:i + 65536], OWv[i:i + 65536])
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
        if a.linear:
            return {f'rules/{rule_name(i)}': w for i, w in zip(inputs, net.linear.weight.detach().cpu().flatten().tolist())}
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
            base = pl_rows(score(x, ow)[0], o)[0].mean().item()
            rows = []
            for name, cols in GROUPS:
                if not any(c in set(inputs) for c in cols):
                    continue
                xs = x.clone()
                perm = torch.randperm(len(x), device=x.device)
                xs[:, :, cols] = x[perm][:, :, cols]
                rows.append([name, pl_rows(score(xs, ow)[0], o)[0].mean().item() - base])
        net.train()
        return sorted(rows, key=lambda r: -r[1])

    step = 0
    for ep in range(a.epochs):
        perm = torch.randperm(len(Xt), device=dev)
        for i in range(0, len(Xt), a.batch):
            b = perm[i:i + a.batch]
            sc, mg = score(Xt[b], OWt[b])
            l_pl = pl_rows(sc, Ot[b])[0].mean()
            if TGt is not None:
                # Cross-entropy between the lambda-return targets and the net's chances over the people still playing.
                live = torch.zeros_like(sc, dtype=torch.bool).scatter_(1, Ot[b].clamp(min=0), Ot[b] >= 0)
                logp = torch.log_softmax(sc.masked_fill(~live, -1e9), 1).masked_fill(~live, 0)
                loss = -(TGt[b] * logp).sum(1).mean() + a.pl_weight * l_pl
            else:
                loss = l_pl
            if a.aux_turns and net.last_turns is not None:
                loss = loss + a.aux_turns * ((net.last_turns - TLt[b]) ** 2).mean()
            if EX is not None:
                tg = torch.nonzero(~EX['gval']).squeeze(1)
                gids = tg[torch.randint(0, len(tg), (a.expert_groups,), device=dev)].unique()
                l_x, _ = pair_loss(gids)
                loss = loss + a.expert_weight * l_x
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
        if EX is not None:
            xl, xa = expert_val()
            by['val/expert_pair_loss'] = xl
            by['val/expert_top_agree'] = xa
            print(f'EXPERT val pair-loss {xl:.4f} (1 = no skill) top-agree {xa:.4f}', flush=True)
        vdh = by['val/loss_double_house']
        cal = ' '.join(f'{p:.2f}->{w:.2f}' for _, p, w, _ in table)
        print(f'EPOCH {ep + 1} train {l_pl.item():.4f} val {vl:.4f} first-logloss {vf:.4f} double-house {vdh:.4f} ece {ece:.4f} calib {cal}', flush=True)
        if run:
            run.log({'epoch': ep + 1, 'val/loss_pl': vl, 'val/first_logloss': vf, 'val/baseline_uniform': base_pl,
                     'val/baseline_first': base_first, 'val/gain_vs_uniform': base_pl - vl, 'val/calib_ece': ece,
                     **by, **health()}, step=step)

    if a.learn_temp:
        # Fold tau into the net's out layer (its score is linear in it) and into alpha, so blend.ts plays the
        # trained sum unchanged: tau * (net + alpha rules) = (tau net) + (tau alpha) rules.
        tau = log_tau.exp().item()
        with torch.no_grad():
            net.out.weight.mul_(tau)
            net.out.bias.mul_(tau)
        a.alpha = a.alpha * tau
        a.learn_temp = False  # score() now means the folded net
        print(f'TEMP tau {tau:.4f} alpha -> {a.alpha:.4f}', flush=True)
        if run:
            run.summary.update({'residual/tau': tau, 'residual/alpha_folded': a.alpha})
    dump = lambda l: {'W': l.weight.detach().cpu().double().tolist(), 'b': l.bias.detach().cpu().double().tolist()}
    if a.linear:
        weights = {rule_name(i): w for i, w in zip(inputs, net.linear.weight.detach().cpu().double().flatten().tolist())}
        json.dump({'kind': 'linear', 'weights': weights}, open(a.out, 'w'), indent=1)
        print('RULES ' + ' '.join(f'{k}:{v:+.3f}' for k, v in sorted(weights.items(), key=lambda kv: -abs(kv[1]))), flush=True)
    else:
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
    if rules_w is not None:
        # The rules part on the same positions, against linear.ts (the blend adds the two as blend.ts does).
        rp = a.out + '.rules.json'
        json.dump(json.load(open(a.rules)), open(rp, 'w'))
        with torch.no_grad():
            rs = rules_scores(x, ow, torch.float64).masked_fill(~present, float('nan'))
        np.save(rp + '.parity-x.npy', x.cpu().numpy())
        np.save(rp + '.parity-o.npy', ow.double().cpu().numpy())
        np.save(rp + '.parity-s.npy', rs.cpu().numpy())
        res_r = subprocess.run(['node', 'tools/ai/dist/parity.mjs', '--net', rp], capture_output=True, text=True).stdout
        print('RULES ' + res_r.strip(), flush=True)
        par_r = json.loads(res_r.split('PARITY ', 1)[1]) if 'PARITY ' in res_r else {'max': float('nan'), 'ok': False}
        par = {'max': max(par['max'], par_r['max']), 'ok': par['ok'] and par_r['ok'], 'net': par, 'rules': par_r}
        print(f"BLEND blend:{a.out}:{a.rules}:{a.alpha}", flush=True)
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
