"""Tunes the readable rules (linear.ts weights) for strength with CMA-ES.

    python tune.py --start hard2-fit.json --out hard2-tuned.json --opponent net:hard2-fit.json:1
                   [--pop 16] [--seeds 5000] [--gens 30] [--sigma 0.3] [--workers 18] [--wandb hard2-tune]

Fitness of a candidate = its win rate at depth 1 (whole-turn planning with these weights) against a fixed
opponent over paired seeds (A in every seat of each seed, the game's dice), from tools/ai/arena.mjs.
Every generation re-plays the current mean too, since one noisy lucky score must not carry the search.
Weights are searched in units of each weight's own size (sigma x |w| + 0.1), so small and large rules
move alike. Writes the best mean so far after every generation; logs to W&B with --wandb.
"""
import argparse, json, math, os, pathlib, subprocess, tempfile
import numpy as np

ENTITY = os.environ.get('LUDO_WANDB_ENTITY', 'ablations-tinycompany-ai')
ARENA = os.environ.get('LUDO_ARENA', 'node tools/ai/dist/arena.mjs')


def play(weights, names, opponent, mode, seeds, workers, tmp, tag):
    """Win rate of rules `weights` at depth 1 against `opponent`, over `seeds` paired seeds split over workers."""
    path = pathlib.Path(tmp) / f'{tag}.json'
    path.write_text(json.dumps({'kind': 'linear', 'weights': dict(zip(names, map(float, weights)))}))
    step = math.ceil(seeds / workers)
    procs = [subprocess.Popen(f'{ARENA} --a net:{path}:1 --b {opponent} --mode {mode} --from {k * step} --to {min(seeds, (k + 1) * step)}',
                              shell=True, stdout=subprocess.PIPE, text=True) for k in range(workers) if k * step < seeds]
    games = wins = 0
    for p in procs:
        out = p.communicate()[0]
        r = json.loads(out.split('ARENA ', 1)[1])
        games += r['games']
        wins += r['wins']
    return wins / games


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--start', required=True, help='linear rules to start from (train.py --linear)')
    ap.add_argument('--out', required=True)
    ap.add_argument('--opponent', required=True, help='policy spec the candidates play against')
    ap.add_argument('--mode', default='2p')
    ap.add_argument('--pop', type=int, default=16)
    ap.add_argument('--seeds', type=int, default=5000, help='paired seeds per candidate (2 games each in 2p)')
    ap.add_argument('--gens', type=int, default=30)
    ap.add_argument('--sigma', type=float, default=0.3)
    ap.add_argument('--workers', type=int, default=18)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--wandb', default='')
    ap.add_argument('--tmp', default='', help='folder for candidate files (default: a new temp folder)')
    a = ap.parse_args()
    start = json.load(open(a.start))['weights']
    names = list(start)
    w0 = np.array([start[n] for n in names])
    scale = np.abs(w0) + 0.1
    n = len(names)
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
        run = wandb.init(entity=ENTITY, project='tag-team-ludo-ai', name=a.wandb, group='hard2', job_type='tune', config=vars(a))
        print(f'WANDB {run.url}', flush=True)
    tmp = a.tmp or tempfile.mkdtemp(prefix='tune-')
    os.makedirs(tmp, exist_ok=True)
    best = (-1.0, w0)
    for gen in range(a.gens):
        vals, vecs = np.linalg.eigh(C)
        B, Dg = vecs, np.sqrt(np.maximum(vals, 1e-20))
        zs = rng.standard_normal((lam, n))
        ys = zs @ np.diag(Dg) @ B.T
        xs = mean + sigma * ys
        fit = np.array([play(w0 + scale * x, names, a.opponent, a.mode, a.seeds, a.workers, tmp, f'g{gen}c{i}') for i, x in enumerate(xs)])
        incumbent = play(w0 + scale * mean, names, a.opponent, a.mode, a.seeds, a.workers, tmp, f'g{gen}mean')
        if incumbent > best[0]:
            best = (incumbent, w0 + scale * mean)
            json.dump({'kind': 'linear', 'weights': dict(zip(names, map(float, best[1])))}, open(a.out, 'w'), indent=1)
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
        line = {'gen': gen + 1, 'mean_win': incumbent, 'best_candidate': fit.max(), 'median_candidate': float(np.median(fit)), 'sigma': sigma, 'best_mean_win': best[0]}
        print('GEN ' + json.dumps(line), flush=True)
        if run:
            run.log({f'tune/{k}': v for k, v in line.items()} | {f'rules/{k}': float(v) for k, v in zip(names, w0 + scale * mean)})
    if run:
        run.summary.update({'tune/best_mean_win': best[0]})
        run.finish()
    print(f'DONE best mean win {best[0]:.4f} -> {a.out}', flush=True)


if __name__ == '__main__':
    main()
