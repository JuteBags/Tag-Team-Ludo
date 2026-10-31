"""The climb: Extreme self-play generations against a fixed Hard, until it reaches the target or plateaus.

    python ladder.py --start nets/boot-all.json --hard nets/hard2-fit.json --dir work/ladder-r1
                     [--gens 20] [--games 300000] [--grow 1.25] [--max-games 2000000] [--target 0.8]

Each generation k (all resumable: a step whose output exists is skipped):
  1. play: `games` self-play games, each person drawn from the pool (current net at depth 1, sampling its
     moves with a temperature steered so that about --explore (10%) of its choices are not its best move,
     60%; the previous net 15%, Hard 15%, the old Hard 10%), the game's dice;
  2. learn: warm-start from the current net, train on this generation's and the previous one's shards
     (labels: the real results; with --target lambda, ludo-label's lambda-returns along each game, valued
     by the net that played it, plus --pl-weight of the real results);
  3. check: the new net against the current one and against Hard, on a fresh block of paired seeds per
     generation. It is promoted only if it beats the current net clearly (above 50% by more than the 95%
     interval) AND is no worse against Hard than the current net (within the interval).
Games per generation start at --games and grow by --grow after every promotion (more rollouts as the
nets get stronger), up to --max-games. Self-play and arena commands come from LUDO_SELFPLAY and
LUDO_ARENA (Node by default, the Rust engine once it passes its parity gate). Logs to W&B (group ladder).
"""
import argparse, json, math, os, pathlib, shutil, subprocess, sys, time

ENTITY = os.environ.get('LUDO_WANDB_ENTITY', 'ablations-tinycompany-ai')
SELFPLAY = os.environ.get('LUDO_SELFPLAY', 'node tools/ai/dist/selfplay.mjs')
ARENA = os.environ.get('LUDO_ARENA', 'node tools/ai/dist/arena.mjs')
LABEL = os.environ.get('LUDO_LABEL', 'sim-rs/target/release/ludo-label')


def run_parallel(cmds):
    procs = [subprocess.Popen(c, shell=True, stdout=subprocess.PIPE, text=True) for c in cmds]
    outs = [p.communicate()[0] for p in procs]
    bad = [c for c, p in zip(cmds, procs) if p.returncode]
    if bad:
        raise SystemExit(f'failed: {bad[0]}')
    return outs


DICE = ''  # ' --dice fair' when the ladder plays on fair dice (set from --dice)


def match(a, b, seeds, workers, base=0, mode='2p'):
    """A's win rate vs B over paired seeds base .. base + seeds, with the 95% interval over seeds."""
    step = math.ceil(seeds / workers)
    rows = [json.loads(o.split('ARENA ', 1)[1]) for o in run_parallel(
        [f'{ARENA} --a {a} --b {b} --mode {mode} --from {base + k * step} --to {base + min(seeds, (k + 1) * step)}{DICE}' for k in range(workers) if k * step < seeds])]
    g, w, s = sum(r['games'] for r in rows), sum(r['wins'] for r in rows), sum(r['seeds'] for r in rows)
    m = w / s
    se = math.sqrt(max(0.0, sum(r['seedSq'] for r in rows) / s - m * m) / s) / rows[0]['people']
    return w / g, 1.96 * se, g


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--start', required=True, help='Extreme net to start from')
    ap.add_argument('--hard', required=True, help='the Hard to climb against (linear rules json)')
    ap.add_argument('--dir', required=True)
    ap.add_argument('--gens', type=int, default=20)
    ap.add_argument('--games', type=int, default=300_000)
    ap.add_argument('--grow', type=float, default=1.25)
    ap.add_argument('--max-games', type=int, default=2_000_000)
    ap.add_argument('--keep', type=float, default=0.012)
    ap.add_argument('--temp', type=float, default=0.01, help='starting move temperature in self-play (values are P(win), so gaps are small)')
    ap.add_argument('--dice', default='game', choices=['game', 'fair'], help='fair: the engine trains and is checked on fair dice')
    ap.add_argument('--race', type=int, default=0, help='self-play nets use the race endgame tables (policy field 6)')
    ap.add_argument('--chance', type=int, default=2, help='self-play chance cap (policy field 7); checks always use the full search')
    ap.add_argument('--cut', type=float, default=0.0, help='self-play probe cut (policy field 8)')
    ap.add_argument('--explore', type=float, default=0.10, help='target share of sampled moves that are not the best; steers the temperature')
    ap.add_argument('--seeds', type=int, default=5000, help='paired seeds per check')
    ap.add_argument('--target', type=float, default=0.8)
    ap.add_argument('--workers', type=int, default=14, help='self-play processes; keep the box responsive (at most 16 of 20 cores)')
    ap.add_argument('--wandb', default='ladder-r1')
    ap.add_argument('--replay', type=int, default=3, help='generations of games each training step uses (this one and the ones before)')
    ap.add_argument('--seed-base', type=int, default=0, help='added to every self-play seed (a second ladder line plays other games)')
    ap.add_argument('--labels', default='outcome', choices=['outcome', 'lambda'], help="lambda: ludo-label's lambda-return targets (train.py --target lambda)")
    ap.add_argument('--lam', type=float, default=0.7, help='lambda of the lambda-return targets')
    ap.add_argument('--pl-weight', type=float, default=0.1, help='with --labels lambda, this much PL on the real finishing order')
    a = ap.parse_args()
    global DICE
    DICE = ' --dice fair' if a.dice == 'fair' else ''
    d = pathlib.Path(a.dir)
    d.mkdir(parents=True, exist_ok=True)
    state_file = d / 'state.json'
    st = json.loads(state_file.read_text()) if state_file.exists() else {'gen': 0, 'current': a.start, 'previous': a.start, 'games': a.games, 'temp': a.temp, 'history': []}
    commit = subprocess.run(['git', 'log', '-1', '--format=%h'], capture_output=True, text=True).stdout.strip()
    import wandb
    # One W&B run per ladder, its id kept in the state file so a resumed ladder logs to the same run.
    st.setdefault('wandb_id', f"{a.wandb}-{time.strftime('%Y%m%d-%H%M%S')}")
    state_file.write_text(json.dumps(st, indent=1))
    run = wandb.init(entity=ENTITY, project='tag-team-ludo-ai', name=a.wandb, group='ladder', job_type='ladder',
                     config={**vars(a), 'engine_commit': commit, 'selfplay': SELFPLAY, 'arena': ARENA}, resume='allow', id=st['wandb_id'])
    print(f'WANDB {run.url}', flush=True)
    if 'vs_hard_current' not in st:
        st['vs_hard_current'] = match(f"net:{st['current']}:1", f'net:{a.hard}:1', a.seeds, a.workers, base=10_000_000)[0]
        print(f"START vs Hard {st['vs_hard_current']:.4f}", flush=True)
    while st['gen'] < a.gens:
        k = st['gen'] + 1
        gd = d / f'gen-{k}'
        gd.mkdir(exist_ok=True)
        cur, prev, n = st['current'], st['previous'], int(st['games'])
        t0 = time.time()
        # 1. play
        temp = st.get('temp', a.temp)
        fast = f'{a.race}:{a.chance}:{a.cut}'  # how the nets search in self-play (the checks use the defaults)
        pool = f"net:{cur}:1:3:{temp}:{fast}:60,net:{prev}:1:3:{temp}:{fast}:15,net:{a.hard}:1:15,hard:10"
        per = math.ceil(n / a.workers)
        todo = [f"{SELFPLAY} --games {per} --seed {a.seed_base + k * 1000 + w} --pool {pool} --keep {a.keep} --commit {commit} --out {gd}/shard-{w}.bin{DICE}"
                for w in range(a.workers) if not (gd / f'shard-{w}.bin').exists()]
        sampled = off = 0
        if todo:
            for out in run_parallel(todo):
                done = [l for l in out.splitlines() if l.startswith('DONE ')]
                if done and 'offBest' in done[-1]:
                    words = done[-1].split()
                    sampled += int(words[words.index('sampled') + 1])
                    off += int(words[words.index('offBest') + 1])
        explored = off / sampled if sampled else None
        if explored is not None:
            # Off-best share grows with the temperature; move it toward the target, at most 2x per generation.
            st['temp'] = temp * min(2.0, max(0.5, (a.explore / max(explored, 1e-3)) ** 0.7))
        t_play = time.time() - t0
        # 2. learn: the last --replay generations' games that this ladder played (this one included)
        new = gd / 'net.json'
        shards = ','.join(f'{d}/gen-{j}/shard-*.bin' for j in range(max(1, k - a.replay + 1), k + 1)
                          if any((d / f'gen-{j}').glob('shard-*.bin')))
        target = []
        if a.labels == 'lambda':
            # lambda-return targets for this generation's shards, valued by the net that played them (cur)
            todo_l = [f'{LABEL} --shard {f} --net {cur} --lambda {a.lam} --out {f}.targets --threads 1'
                      for f in sorted(gd.glob('shard-*.bin')) if not pathlib.Path(f'{f}.targets').exists()]
            if todo_l:
                run_parallel(todo_l)
            target = ['--target', 'lambda', '--pl-weight', str(a.pl_weight)]
        if not new.exists():
            subprocess.run([sys.executable, '-u', 'tools/ai/train.py', '--shards', shards, '--init', cur, '--out', str(new),
                            '--hidden', '128', '--layers', '2', '--epochs', '3', '--lr', '1e-3', '--wandb', f'{a.wandb}-gen{k}', '--group', 'ladder', *target], check=True)
        t_learn = time.time() - t0 - t_play
        # 3. check
        block = 1_000_000 + k * a.seeds  # fresh dice for every generation's checks
        vs_cur, ci_cur, games_cur = match(f'net:{new}:1', f'net:{cur}:1', a.seeds, a.workers, block)
        vs_hard, ci_hard, _ = match(f'net:{new}:1', f'net:{a.hard}:1', a.seeds, a.workers, block)
        promoted = vs_cur - ci_cur > 0.5 and vs_hard >= st['vs_hard_current'] - ci_hard
        line = {'gen': k, 'games': n, 'temp': temp, 'explored': explored, 'vs_current': vs_cur, 'vs_current_ci': ci_cur, 'vs_hard': vs_hard, 'vs_hard_ci': ci_hard,
                'promoted': promoted, 'play_s': round(t_play), 'learn_s': round(t_learn), 'total_s': round(time.time() - t0)}
        print('GEN ' + json.dumps(line), flush=True)
        run.log({f'ladder/{key}': v for key, v in line.items() if key != 'gen'} | {'ladder/gen': k})
        if promoted:
            st['previous'], st['current'] = cur, str(new)
            st['games'] = min(a.max_games, int(n * a.grow))
            st['vs_hard_current'] = vs_hard
            shutil.copy(new, d / 'best.json')
        st['gen'] = k
        st['history'].append(line)
        state_file.write_text(json.dumps(st, indent=1))
        # Off the box at once (a box can die any time): this generation's games, net and state as one
        # W&B artifact. Shards are gzipped in parallel first; W&B uploads in the background.
        subprocess.run(f'ls {gd}/shard-*.bin | xargs -P {a.workers} -n 1 nice -n 10 gzip -1 -k -f', shell=True, check=False)
        import wandb as _wb
        art = _wb.Artifact(f'{a.wandb}-gen{k}-data', type='generation', metadata=line | {'pool': pool, 'commit': commit})
        for f in sorted(gd.glob('shard-*.bin.gz')):
            art.add_file(str(f))
        art.add_file(str(new), name='net.json')
        art.add_file(str(state_file), name='state.json')
        run.log_artifact(art)
        if promoted and vs_hard >= a.target:
            print(f'TARGET reached: {vs_hard:.3f} vs Hard', flush=True)
            break
    run.finish()
    print('DONE', json.dumps(st['history'][-1] if st['history'] else {}), flush=True)


if __name__ == '__main__':
    main()
