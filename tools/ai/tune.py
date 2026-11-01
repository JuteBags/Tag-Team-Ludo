"""Tunes the readable rules (linear.ts weights) for strength with CMA-ES.

    python tune.py --start hard2-fit.json --out hard2-tuned.json --opponent net:hard2-fit.json:1
                   [--pop 16] [--seeds 5000] [--gens 30] [--sigma 0.3] [--workers 18] [--wandb hard2-tune]

Fitness of a candidate = its mean win rate at depth 1 (whole-turn planning with these weights) against
the opponents (comma-separated policy specs) over paired seeds, from the arena (LUDO_ARENA). All
candidates of a generation share one fresh block of seeds (common random numbers within a generation,
new dice every generation, so the weights cannot fit one set of games). Every generation re-plays the
current mean too. The final weights are scored once more on a held-out block never used in tuning.
Every rule is tuned, including ones the fit left at 0 (the full feature list, without the per-game
singles flag, plus the turn-in-progress rules).
Weights are searched in units of each weight's own size (sigma x |w| + 0.1), so small and large rules
move alike. Writes the best mean so far after every generation; logs to W&B with --wandb.

With --net, the candidates are Extreme blends instead: blend:<net>:<rules>:<alpha>:1 (the net's score plus
alpha times these rules), the net fixed and the rules and alpha evolved (alpha in log units). This is the
evolutionary half of the ladder: self-play trains the net, evolution re-tunes the readable part around it.
The best blend is also written to <out>.blend.json as {net, rules, alpha}.

--pick final (for noisy fitness, e.g. short 4p runs): the best single generation's score is mostly luck
(winner's curse), so instead the final CMA-ES mean and the starting point play one shared held-out block
and the better of the two is written.
"""
import argparse, json, math, os, pathlib, subprocess, tempfile
import numpy as np

ENTITY = os.environ.get('LUDO_WANDB_ENTITY', 'ablations-tinycompany-ai')
ARENA = os.environ.get('LUDO_ARENA', 'node tools/ai/dist/arena.mjs')


DICE = ''  # ' --dice fair' to tune on fair dice (set from --dice)


NET, SEARCH = '', ''  # --net: candidates are blends of this net (SEARCH: extra policy fields after the depth)


def play(weights, names, opponents, mode, seeds, workers, tmp, tag, base=0, alpha=None):
    """Mean win rate of rules `weights` at depth 1 (or of the blend with NET at `alpha`) against `opponents`,
    over paired seeds base .. base + seeds."""
    path = pathlib.Path(tmp) / f'{tag}.json'
    path.write_text(json.dumps({'kind': 'linear', 'weights': dict(zip(names, map(float, weights)))}))
    spec = f'blend:{NET}:{path}:{alpha:.6g}:1{SEARCH}' if NET else f'net:{path}:1'

    step = math.ceil(seeds / workers)
    rates = []
    for opponent in opponents:
        procs = [subprocess.Popen(f'{ARENA} --a {spec} --b {opponent} --mode {mode} --from {base + k * step} --to {base + min(seeds, (k + 1) * step)}{DICE}',
                                  shell=True, stdout=subprocess.PIPE, text=True) for k in range(workers) if k * step < seeds]
        games = wins = 0
        for p in procs:
            r = json.loads(p.communicate()[0].split('ARENA ', 1)[1])
            games += r['games']
            wins += r['wins']
        rates.append(wins / games)
    return sum(rates) / len(rates)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--start', required=True, help='linear rules to start from (train.py --linear)')
    ap.add_argument('--out', required=True)
    ap.add_argument('--opponent', required=True, help='policy specs the candidates play against, comma-separated (fitness = mean)')
    ap.add_argument('--dice', default='game', choices=['game', 'fair'])
    ap.add_argument('--holdout', type=int, default=10_000, help='paired seeds for the final, held-out score')
    ap.add_argument('--pick', default='best', choices=['best', 'final'], help='best: the best generation mean; final: the final mean or the start, '
                    'whichever wins the held-out block')
    ap.add_argument('--mode', default='2p')
    ap.add_argument('--pop', type=int, default=16)
    ap.add_argument('--seeds', type=int, default=5000, help='paired seeds per candidate (2 games each in 2p)')
    ap.add_argument('--gens', type=int, default=30)
    ap.add_argument('--sigma', type=float, default=0.3)
    ap.add_argument('--workers', type=int, default=18)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--wandb', default='')
    ap.add_argument('--net', default='', help='evolve blends of this net instead of bare rules (Extreme)')
    ap.add_argument('--alpha', type=float, default=2.0, help='with --net: the starting alpha')
    ap.add_argument('--search', default='', help="with --net: policy fields after the depth, e.g. ':3:0:0:1:0.01' (cap 1, cut 0.01)")
    ap.add_argument('--seed-base', type=int, default=0, help='first paired seed of generation 1 (a new run plays new games)')
    ap.add_argument('--tmp', default='', help='folder for candidate files (default: a new temp folder)')
    a = ap.parse_args()
    global DICE, NET, SEARCH
    DICE = ' --dice fair' if a.dice == 'fair' else ''
    NET, SEARCH = a.net, a.search
    start = json.load(open(a.start))['weights']
    # Every rule, including ones the start leaves out (they start at 0).
    names = ['pipsLeft', 'base', 'home', 'column', 'danger', 'dangerProg', 'prey', 'preyProg', 'safe', 'blocks',
             'blocking', 'ambush', 'maxProg', 'minProg', 'turn0', 'turn1', 'turn2', 'turn3',
             'tray1', 'tray2', 'tray3', 'tray4', 'tray5', 'tray6', 'sixes',
             'rollActive', 'rollBase', 'rollColumn', 'rollPrey', 'leadGap']
    w0 = np.array([start.get(n, 0.0) for n in names])
    opponents = a.opponent.split(',')
    scale = np.abs(w0) + 0.1
    n = len(names) + bool(a.net)  # with --net, the last coordinate is log(alpha / start alpha)
    rng = np.random.default_rng(a.seed)

    # CMA-ES in scaled coordinates z (weights = w0 + scale * z), standard settings (Hansen's tutorial).
    lam, mu = a.pop, a.pop // 2
    wts = np.log(mu + 0.5) - np.log(np.arange(1, mu + 1))
    wts /= wts.sum()
    mueff = 1 / (wts ** 2).sum()
    cc, cs = (4 + mueff / n) / (n + 4 + 2 * mueff / n), (mueff + 2) / (n + mueff + 5)
    c1 = 2 / ((n + 1.3) ** 2 + mueff)
    cmu = min(1 - c1, 2 * (mueff - 2 + 1 / mueff) / ((n + 2) ** 2 + mueff))
    damps = 1 + 2 * max(0, math.sqrt((mueff - 1) / (n + 1)) - 1) + cs
    chin = math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n))
    mean, sigma = np.zeros(n), a.sigma
    C, pc, ps = np.eye(n), np.zeros(n), np.zeros(n)

    run = None
    if a.wandb:
        import wandb
        run = wandb.init(entity=ENTITY, project='tag-team-ludo-ai', name=a.wandb, group='extreme' if a.net else 'hard2', job_type='tune', config=vars(a))
        print(f'WANDB {run.url}', flush=True)
    tmp = a.tmp or tempfile.mkdtemp(prefix='tune-')
    os.makedirs(tmp, exist_ok=True)
    split = lambda x: (w0 + scale * x[:len(names)], a.alpha * math.exp(x[-1]) if a.net else None)  # weights, alpha
    score = lambda x, tag, seeds, base: play(split(x)[0], names, opponents, a.mode, seeds, a.workers, tmp, tag, base, split(x)[1])
    best = (-1.0, np.zeros(n))

    def write(x):
        w, alpha = split(x)
        json.dump({'kind': 'linear', 'weights': dict(zip(names, map(float, w)))}, open(a.out, 'w'), indent=1)
        if a.net:
            json.dump({'net': a.net, 'rules': a.out, 'alpha': alpha}, open(a.out + '.blend.json', 'w'), indent=1)
    for gen in range(a.gens):
        vals, vecs = np.linalg.eigh(C)
        B, Dg = vecs, np.sqrt(np.maximum(vals, 1e-20))
        zs = rng.standard_normal((lam, n))
        ys = zs @ np.diag(Dg) @ B.T
        xs = mean + sigma * ys
        block = a.seed_base + gen * a.seeds  # fresh dice every generation, shared by its candidates
        fit = np.array([score(x, f'g{gen}c{i}', a.seeds, block) for i, x in enumerate(xs)])
        incumbent = score(mean, f'g{gen}mean', a.seeds, block)
        if incumbent > best[0]:
            best = (incumbent, mean.copy())
            write(best[1])
        order = np.argsort(-fit)
        old = mean
        mean = mean + sigma * (wts @ ys[order[:mu]])
        # Step-size and covariance adaptation.
        invsqrt = B @ np.diag(1 / Dg) @ B.T
        ps = (1 - cs) * ps + math.sqrt(cs * (2 - cs) * mueff) * invsqrt @ (mean - old) / sigma
        hsig = np.linalg.norm(ps) / math.sqrt(1 - (1 - cs) ** (2 * (gen + 1))) / chin < 1.4 + 2 / (n + 1)
        pc = (1 - cc) * pc + hsig * math.sqrt(cc * (2 - cc) * mueff) * (mean - old) / sigma
        art = ys[order[:mu]]
        C = (1 - c1 - cmu) * C + c1 * (np.outer(pc, pc) + (not hsig) * cc * (2 - cc) * C) + cmu * (art.T * wts) @ art
        sigma *= math.exp((cs / damps) * (np.linalg.norm(ps) / chin - 1))
        line = {'gen': gen + 1, 'mean_win': incumbent, **({'alpha': split(mean)[1]} if a.net else {}), 'best_candidate': fit.max(), 'median_candidate': float(np.median(fit)), 'sigma': sigma, 'best_mean_win': best[0]}
        print('GEN ' + json.dumps(line), flush=True)
        if run:
            run.log({f'tune/{k}': v for k, v in line.items()} | {f'rules/{k}': float(v) for k, v in zip(names, split(mean)[0])})
    # The honest number: the chosen weights on seeds no generation ever played.
    if a.pick == 'final':
        # One shared held-out block (common dice) for the final mean and the start; keep the better.
        held_final = score(mean, 'holdout-final', a.holdout, 50_000_000 + a.seed_base)
        held_start = score(np.zeros(n), 'holdout-start', a.holdout, 50_000_000 + a.seed_base)
        print(f'PICK final mean {held_final:.4f} vs start {held_start:.4f} on {a.holdout} held-out seeds', flush=True)
        best = (held_final, mean.copy()) if held_final > held_start else (held_start, np.zeros(n))
        write(best[1])
        held = best[0]
        if run:
            run.summary.update({'tune/holdout_final': held_final, 'tune/holdout_start': held_start})
    else:
        held = score(best[1], 'holdout', a.holdout, 50_000_000)
    if run:
        run.summary.update({'tune/best_mean_win': best[0], 'tune/holdout_win': held})
        run.finish()
    print(f'DONE best mean win {best[0]:.4f}, held-out {held:.4f} -> {a.out}', flush=True)


if __name__ == '__main__':
    main()
