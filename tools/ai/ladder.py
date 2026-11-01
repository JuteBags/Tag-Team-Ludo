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
With --blend RULES (and --alpha), the player is the Extreme blend, blend:<net>:<rules>:<alpha> (the net's
score plus alpha times readable rules), and every generation mixes self-play with evolution:
  play with the current blend -> train the net -> 2b. evolve: CMA-ES (tune.py --net) re-tunes the rules and
  alpha around the new net, fitness = its --check-mode win rate against Hard -> check the new blend.
A fresh blend ladder evolves around its starting net once before the first game (generation 0).
The checks are 4p by default: the tested engine holds one house, the baseline the other three (each
playing for itself), every seed played from each house; equal strength is 1/4, and "beats clearly"
means above 1/4 by more than the interval. --check-mode 2p gives the old head-to-head.
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


def save(run, name, files, metadata, workers):
    """Off the box at once (a box can die any time): `files` (name in artifact -> local path) as one W&B
    artifact. Shards and lambda targets are gzipped in parallel first; W&B uploads in the background and
    stores each file once across artifacts (content-addressed), so a file saved twice costs nothing."""
    big = [f for f in files.values() if f.endswith(('.bin', '.targets'))]
    if big:
        subprocess.run(f"printf '%s\\n' {' '.join(big)} | xargs -P {workers} -n 1 nice -n 10 gzip -1 -k -f", shell=True, check=False)
    import wandb as _wb
    art = _wb.Artifact(name, type='generation', metadata=metadata)
    for key, f in files.items():
        gz = f.endswith(('.bin', '.targets'))
        if pathlib.Path(f + '.gz' if gz else f).exists():
            art.add_file(f + '.gz' if gz else f, name=key + '.gz' if gz else key)
    run.log_artifact(art)


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
    ap.add_argument('--check-mode', default='4p', help='mode of the checks (4p: one house tested, three baseline houses)')
    ap.add_argument('--blend', default='', help='rules json: play and check the blend net + alpha * rules, evolving the rules every generation')
    ap.add_argument('--alpha', type=float, default=2.0, help='with --blend: the starting alpha')
    ap.add_argument('--evolve-gens', type=int, default=8, help='with --blend: CMA-ES generations per ladder generation')
    ap.add_argument('--evolve-pop', type=int, default=10)
    ap.add_argument('--evolve-seeds', type=int, default=800, help='paired seeds per CMA-ES candidate')
    ap.add_argument('--evolve-sigma', type=float, default=0.15)
    ap.add_argument('--residual', action='store_true', help='with --blend: train the net as a residual over the frozen rules (train.py --rules/--alpha)')
    ap.add_argument('--learn-temp', action='store_true', help="with --residual: train.py --learn-temp; the new net's alpha is the BLEND line's tau * alpha")
    a = ap.parse_args()
    global DICE
    DICE = ' --dice fair' if a.dice == 'fair' else ''
    d = pathlib.Path(a.dir)
    d.mkdir(parents=True, exist_ok=True)
    state_file = d / 'state.json'
    st = json.loads(state_file.read_text()) if state_file.exists() else {'gen': 0, 'current': a.start, 'previous': a.start, 'games': a.games, 'temp': a.temp, 'history': []}
    if a.blend:
        st.setdefault('rules', a.blend)
        st.setdefault('alpha', a.alpha)
        st.setdefault('prev_rules', st['rules'])
        st.setdefault('prev_alpha', st['alpha'])
    par = 1 / int(a.check_mode[0])  # equal strength in the checks

    def spec(net, rules=None, alpha=None, extra=''):
        """The player's policy spec: the blend of `net` (with these rules and alpha), or the bare net."""
        return f'blend:{net}:{rules}:{alpha:.6g}:1{extra}' if a.blend else f'net:{net}:1{extra}'

    def evolve(net, rules, alpha, out_dir, tag, seed_base):
        """Short CMA-ES over the rules and alpha around `net`; returns the best (rules file, alpha). Resumable."""
        out = out_dir / 'rules.json'
        if not (out_dir / 'evolve.done').exists():
            subprocess.run([sys.executable, '-u', 'tools/ai/tune.py', '--start', rules, '--net', str(net), '--alpha', str(alpha), '--out', str(out),
                            '--opponent', f'net:{a.hard}:1', '--mode', a.check_mode, '--dice', a.dice, '--pop', str(a.evolve_pop),
                            '--seeds', str(a.evolve_seeds), '--gens', str(a.evolve_gens), '--sigma', str(a.evolve_sigma), '--workers', str(a.workers),
                            '--search', f':3:0:{a.race}:{a.chance}:{a.cut}', '--seed-base', str(seed_base), '--holdout', str(2 * a.evolve_seeds), '--pick', 'final', '--tmp', str(out_dir / 'evolve'),
                            '--wandb', f'{a.wandb}-{tag}-evolve'], check=True)
            (out_dir / 'evolve.done').write_text('')
        return str(out), json.loads((out_dir / 'rules.json.blend.json').read_text())['alpha']
    commit = subprocess.run(['git', 'log', '-1', '--format=%h'], capture_output=True, text=True).stdout.strip()
    import wandb
    # One W&B run per ladder, its id kept in the state file so a resumed ladder logs to the same run.
    st.setdefault('wandb_id', f"{a.wandb}-{time.strftime('%Y%m%d-%H%M%S')}")
    state_file.write_text(json.dumps(st, indent=1))
    def start_run():
        return wandb.init(entity=ENTITY, project='tag-team-ludo-ai', name=a.wandb, group='ladder', job_type='ladder',
                          config={**vars(a), 'engine_commit': commit, 'selfplay': SELFPLAY, 'arena': ARENA}, resume='allow', id=st['wandb_id'])
    try:
        run = start_run()
    except Exception as e:  # a crashed ladder's run can stay "in use" for a while: carry on in a new run
        if 'in use' not in str(e):
            raise
        st['wandb_id'] = f"{a.wandb}-{time.strftime('%Y%m%d-%H%M%S')}"
        state_file.write_text(json.dumps(st, indent=1))
        run = start_run()
    print(f'WANDB {run.url}', flush=True)
    if a.blend and st['gen'] == 0 and not st.get('evolved0'):
        # Generation 0: evolve the readable part around the starting net before the first game.
        (d / 'gen-0').mkdir(exist_ok=True)
        st['rules'], st['alpha'] = evolve(st['current'], st['rules'], st['alpha'], d / 'gen-0', 'gen0', 3_000_000)
        st['prev_rules'], st['prev_alpha'] = st['rules'], st['alpha']
        st['evolved0'] = True
        st.pop('vs_hard_current', None)
        state_file.write_text(json.dumps(st, indent=1))
        save(run, f'{a.wandb}-gen0-data', {'rules.json': st['rules'], 'rules.json.blend.json': st['rules'] + '.blend.json', 'state.json': str(state_file)},
             {'gen': 0, 'alpha': st['alpha'], 'commit': commit}, a.workers)
    if 'vs_hard_current' not in st or st.get('check_mode', '2p') != a.check_mode:
        st['vs_hard_current'] = match(spec(st['current'], st.get('rules'), st.get('alpha')), f'net:{a.hard}:1', a.seeds, a.workers, base=10_000_000, mode=a.check_mode)[0]
        st['check_mode'] = a.check_mode
        state_file.write_text(json.dumps(st, indent=1))
        print(f"START vs Hard {st['vs_hard_current']:.4f} ({a.check_mode}, equal = {par:.3f})", flush=True)
    while st['gen'] < a.gens:
        k = st['gen'] + 1
        gd = d / f'gen-{k}'
        gd.mkdir(exist_ok=True)
        cur, prev, n = st['current'], st['previous'], int(st['games'])
        t0 = time.time()
        # 1. play
        temp = st.get('temp', a.temp)
        fast = f'{a.race}:{a.chance}:{a.cut}'  # how the nets search in self-play (the checks use the defaults)
        pool = (f"{spec(cur, st.get('rules'), st.get('alpha'), f':3:{temp}:{fast}')}:60,"
                f"{spec(prev, st.get('prev_rules'), st.get('prev_alpha'), f':3:{temp}:{fast}')}:15,net:{a.hard}:1:15,hard:10")
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
        if todo:  # this run played them: save the games before the learn/evolve/check phases
            save(run, f'{a.wandb}-gen{k}-games', {f.name: str(f) for f in sorted(gd.glob('shard-*.bin'))},
                 {'gen': k, 'pool': pool, 'commit': commit, 'temp': temp}, a.workers)
        # 2. learn: the last --replay generations' games that this ladder played (this one included)
        new = gd / 'net.json'
        shards = ','.join(f'{d}/gen-{j}/shard-*.bin' for j in range(max(1, k - a.replay + 1), k + 1)
                          if any((d / f'gen-{j}').glob('shard-*.bin')))
        target = []
        if a.labels == 'lambda':
            # lambda-return targets for this generation's shards, valued by the player that played them (cur)
            # with --blend, valued as the blend plays (ludo-label --eval blend:..., the current rules and alpha)
            value = f"--eval blend:{cur}:{st['rules']}:{st['alpha']}" if a.blend else f'--net {cur}'
            todo_l = [f'{LABEL} --shard {f} {value} --lambda {a.lam} --out {f}.targets --threads 1'
                      for f in sorted(gd.glob('shard-*.bin')) if not pathlib.Path(f'{f}.targets').exists()]
            if todo_l:
                run_parallel(todo_l)
            target = ['--target', 'lambda', '--pl-weight', str(a.pl_weight)]
        residual = a.blend and a.residual
        new_blend = gd / 'blend.json'  # residual mode: the rules and alpha the new net was trained against
        if not new.exists():
            train = subprocess.Popen([sys.executable, '-u', 'tools/ai/train.py', '--shards', shards, '--init', cur, '--out', str(new),
                                      '--hidden', '128', '--layers', '2', '--epochs', '3', '--lr', '1e-3', '--wandb', f'{a.wandb}-gen{k}', '--group', 'ladder', *target,
                                      *(['--rules', st['rules'], '--alpha', str(st['alpha'])] if residual else []),
                                      *(['--learn-temp'] if residual and a.learn_temp else [])], stdout=subprocess.PIPE, text=True)
            blend_line = ''
            for line in train.stdout:  # echo the trainer's log, keep its BLEND line (alpha' = tau * alpha)
                print(line, end='', flush=True)
                if line.startswith('BLEND '):
                    blend_line = line.split()[1]
            if train.wait():
                raise subprocess.CalledProcessError(train.returncode, 'train.py')
            if residual:
                new_blend.write_text(json.dumps({'rules': st['rules'], 'alpha': float(blend_line.rsplit(':', 1)[1]) if blend_line else st['alpha']}))
        t_learn = time.time() - t0 - t_play
        # 2b. evolve the readable part around the new net
        start_alpha = json.loads(new_blend.read_text())['alpha'] if residual else st.get('alpha')
        new_rules, new_alpha = evolve(new, st['rules'], start_alpha, gd, f'gen{k}', 3_000_000 + k * 100_000) if a.blend else (None, None)
        t_evolve = time.time() - t0 - t_play - t_learn
        # 3. check
        block = 1_000_000 + k * a.seeds  # fresh dice for every generation's checks
        cand = spec(new, new_rules, new_alpha)
        vs_cur, ci_cur, games_cur = match(cand, spec(cur, st.get('rules'), st.get('alpha')), a.seeds, a.workers, block, a.check_mode)
        vs_hard, ci_hard, _ = match(cand, f'net:{a.hard}:1', a.seeds, a.workers, block, a.check_mode)
        promoted = vs_cur - ci_cur > par and vs_hard >= st['vs_hard_current'] - ci_hard
        line = {'gen': k, 'games': n, 'temp': temp, 'explored': explored, 'vs_current': vs_cur, 'vs_current_ci': ci_cur, 'vs_hard': vs_hard, 'vs_hard_ci': ci_hard,
                'check_mode': a.check_mode, **({'alpha': new_alpha} if a.blend else {}),
                'promoted': promoted, 'play_s': round(t_play), 'learn_s': round(t_learn), 'evolve_s': round(t_evolve), 'total_s': round(time.time() - t0)}
        print('GEN ' + json.dumps(line), flush=True)
        run.log({f'ladder/{key}': v for key, v in line.items() if key != 'gen'} | {'ladder/gen': k})
        if promoted:
            st['previous'], st['current'] = cur, str(new)
            st['games'] = min(a.max_games, int(n * a.grow))
            st['vs_hard_current'] = vs_hard
            shutil.copy(new, d / 'best.json')
            if a.blend:
                st['prev_rules'], st['prev_alpha'], st['rules'], st['alpha'] = st['rules'], st['alpha'], new_rules, new_alpha
                shutil.copy(new_rules, d / 'best-rules.json')
                (d / 'best-blend.json').write_text(json.dumps({'net': str(d / 'best.json'), 'rules': str(d / 'best-rules.json'), 'alpha': new_alpha}))
        st['gen'] = k
        st['history'].append(line)
        state_file.write_text(json.dumps(st, indent=1))
        # This generation as one artifact: games (+ lambda targets), net, state, evolved rules, residual blend.
        files = {f.name: str(f) for f in sorted(gd.glob('shard-*.bin')) + sorted(gd.glob('shard-*.bin.targets'))}
        files |= {'net.json': str(new), 'state.json': str(state_file)}
        if new_rules:
            files |= {'rules.json': new_rules, 'rules.json.blend.json': new_rules + '.blend.json'}
        if new_blend.exists():
            files['blend.json'] = str(new_blend)
        save(run, f'{a.wandb}-gen{k}-data', files, line | {'pool': pool, 'commit': commit}, a.workers)
        if promoted and vs_hard >= a.target:
            print(f'TARGET reached: {vs_hard:.3f} vs Hard', flush=True)
            break
    run.finish()
    print('DONE', json.dumps(st['history'][-1] if st['history'] else {}), flush=True)


if __name__ == '__main__':
    main()
