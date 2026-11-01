"""Rebuilds a ladder's folder from its W&B artifacts after a box dies, so ladder.py resumes where it stopped.

    python restore_ladder.py --wandb ladder-r2 --dir /home/marimo/work/ladder-r2 [--replay 3]

ladder.py saves <wandb>-gen<k>-data after every generation (games, lambda targets, net, state, rules, blend;
gen 0 = the evolution before the first game) and <wandb>-gen<k>-games as soon as a generation's play ends.
This downloads the newest generation's state, every generation's small files (nets, rules, blends: the
state points at them), the games and targets of the last --replay generations (the training window), and
the games of a generation whose play had finished. Paths in the state are rewritten if --dir moved.
Prints RESTORED {...}; refuses to touch a folder that already has a state file.
"""
import argparse, gzip, json, os, pathlib, shutil

ENTITY = os.environ.get('LUDO_WANDB_ENTITY', 'ablations-tinycompany-ai')
PROJECT = 'tag-team-ludo-ai'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--wandb', required=True, help="the ladder's --wandb name")
    ap.add_argument('--dir', required=True)
    ap.add_argument('--replay', type=int, default=3)
    a = ap.parse_args()
    import wandb
    api = wandb.Api()
    d = pathlib.Path(a.dir)
    if (d / 'state.json').exists():
        raise SystemExit(f'{d}/state.json exists: not overwriting a live ladder')

    def art(name):
        try:
            return api.artifact(f'{ENTITY}/{PROJECT}/{name}:latest')
        except Exception:
            return None

    gens = {}
    k = 0
    while (x := art(f'{a.wandb}-gen{k}-data')) is not None or k == 0:
        if x is not None:
            gens[k] = x
        k += 1
    if not gens:
        raise SystemExit(f'no {a.wandb}-gen<k>-data artifacts')
    last = max(gens)
    tmp = d / '_restore'

    def fetch(x, gen, want):
        """Downloads the files of artifact x that `want(name)` selects into gen-<gen>/, gunzipping .gz."""
        gd = d / f'gen-{gen}'
        gd.mkdir(parents=True, exist_ok=True)
        got = []
        for name in list(x.manifest.entries):
            if not want(name):
                continue
            path = x.get_entry(name).download(root=str(tmp / f'gen-{gen}'))
            if name.endswith('.gz'):
                with gzip.open(path, 'rb') as src, open(gd / name[:-3], 'wb') as dst:
                    shutil.copyfileobj(src, dst)
            else:
                shutil.copy(path, gd / name)
            got.append(name)
        return got

    small = lambda n: not n.startswith('shard-')
    for gen, x in gens.items():
        fetch(x, gen, small)
    for gen in range(max(1, last - a.replay + 1), last + 1):
        if gen in gens:
            fetch(gens[gen], gen, lambda n: n.startswith('shard-'))
    played = None
    if (g := art(f'{a.wandb}-gen{last + 1}-games')) is not None:
        fetch(g, last + 1, lambda n: n.startswith('shard-'))
        played = last + 1
    # The state of the newest generation; move its paths to --dir if the ladder lived elsewhere.
    st = json.loads((d / f'gen-{last}' / 'state.json').read_text())
    old = next((v.split('/gen-')[0] for key in ('current', 'rules') if isinstance(v := st.get(key), str) and '/gen-' in v), None)
    if old and old != d.as_posix():
        move = lambda v: d.as_posix() + v[len(old):] if isinstance(v, str) and v.startswith(old + '/') else v
        st = {key: move(v) for key, v in st.items()}
    (d / 'state.json').write_text(json.dumps(st, indent=1))
    shutil.rmtree(tmp, ignore_errors=True)
    missing = [v for key in ('current', 'previous', 'rules', 'prev_rules') if isinstance(v := st.get(key), str) and not pathlib.Path(v).exists()]
    print('RESTORED ' + json.dumps({'gen': st['gen'], 'artifacts': sorted(gens), 'games_of_gen': played, 'current': st['current'],
                                    'missing': missing}), flush=True)


if __name__ == '__main__':
    main()
