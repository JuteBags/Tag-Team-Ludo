"""#100: the other Brilliant definitions, scored offline on the logged decisions.
python tools/ai/brilliant_alt.py data/brilliant/native [out.json]

Every definition starts from: the move played is the 256-best at seed A, and seed B's 256-best agrees. Then:
  hard T      Hard's pick is a different move, worse at 256 by >= T points and >= 2 SE (spread >= 3).
  unique T    the 256-best beats the second-best move by >= T points and >= 2 SE (a unique good move, not a near-tie).
  unique T N  the same, and found only above N playouts (n* >= N at both seeds, as in brilliant_score.py).
  save X W    unique X, and the position (the best move's win %) is losing (< 35%), turning (40-60%) or either.
Columns: per player-game for each layout/study; the test (2p): Extreme 0.8-2.5 with both seed halves in band,
Normal at most half of Extreme, random (else first-move) at most 0.1."""
import json, sys, glob, collections, os

sys.path.insert(0, os.path.dirname(__file__))
from brilliant_score import family, first_stable, OLD


def facts(r):
    of, gap, se, mean = r['of'], r['gap'], r['se'], r['mean']
    b = of[r['best']]
    if of[r['played']] != b or of[r['ladder']['b'][-1]] != b:
        return None
    others = [c for c in set(of) if c != b]
    second = min(others, key=lambda c: gap[c])
    at = r.get('at', OLD)
    la, lb = r['ladder']['a'], r['ladder']['b']
    ka, kb = first_stable(la, b, of), first_stable(lb, b, of)
    nstar = min(at[ka], at[kb]) if ka >= 1 and kb >= 1 else 0
    h = of[r['hard']]
    return {'second': (gap[second], se[second]), 'hard': None if h == b else (gap[h], se[h]), 'spread': max(gap),
            'win': mean[b], 'nstar': nstar, 'old': 'at' not in r}


def ok(g, s, t):
    return g >= t and g >= 2 * s


RULES = {}
for t in (1.5, 2, 3, 5, 8):
    RULES[f'hard {t}'] = lambda f, t=t: f['hard'] is not None and ok(*f['hard'], t) and f['spread'] >= 3
for t in (1, 2, 3, 5, 8):
    RULES[f'unique {t}'] = lambda f, t=t: ok(*f['second'], t)
    for n in (16, 32):
        RULES[f'unique {t} n*>={n}'] = lambda f, t=t, n=n: ok(*f['second'], t) and f['nstar'] >= n and not (f['old'] and n < 32)
for x in (3, 5, 8):
    RULES[f'save {x} losing'] = lambda f, x=x: ok(*f['second'], x) and f['win'] < 0.35
    RULES[f'save {x} turning'] = lambda f, x=x: ok(*f['second'], x) and 0.4 <= f['win'] <= 0.6
    RULES[f'save {x} either'] = lambda f, x=x: ok(*f['second'], x) and (f['win'] < 0.35 or 0.4 <= f['win'] <= 0.6)


def main(d, outp=None):
    per = collections.defaultdict(collections.Counter)
    players = collections.defaultdict(set)
    ex = collections.defaultdict(list)
    for f in sorted(glob.glob(d + '/*.jsonl')):
        fam = '%s/%s' % family(f)
        for line in open(f):
            r = json.loads(line)
            p = (r['seed'], r['owner'])
            players[fam].add(p)
            fc = facts(r)
            if fc is None:
                continue
            for name, rule in RULES.items():
                if rule(fc):
                    per[fam][(p, name)] += 1
                    if fam == '2p/extreme' and len(ex[name]) < 5:
                        ex[name].append({'seed': r['seed'], 'n': r['n'], 'moves': r['moves'], 'win': round(100 * fc['win'], 1),
                                         'second_gap': fc['second'][0], 'second_se': fc['second'][1], 'hard': fc['hard'], 'nstar': fc['nstar']})
    fams = [f for f in ['2p/extreme', '2p/normal', '2p/first', '2p/random', '4p/extreme', '2h-opposite/extreme'] if f in players]
    weak = '2p/random' if '2p/random' in players else '2p/first'
    rate = lambda fam, name, sel=lambda p: True: (lambda ps: sum(per[fam][(p, name)] for p in ps) / max(1, len(ps)))([p for p in players[fam] if sel(p)])
    print('| definition | ' + ' | '.join(fams) + ' | Extreme 2p halves | passes |')
    print('|' + '---|' * (len(fams) + 3))
    table = {}
    for name in RULES:
        vals = {fam: rate(fam, name) for fam in fams}
        halves = [rate('2p/extreme', name, lambda p, k=k: p[0] % 2 == k) for k in (0, 1)]
        e = vals['2p/extreme']
        band = lambda v: 0.8 <= v <= 2.5
        passes = band(e) and all(band(h) for h in halves) and vals.get('2p/normal', 9) <= 0.5 * e and vals.get(weak, 9) <= 0.1
        table[name] = {'rates': vals, 'halves': halves, 'passes': passes}
        print(f'| {name} | ' + ' | '.join(f'{vals[f]:.2f}' for f in fams) + f' | {halves[0]:.2f} / {halves[1]:.2f} | {"✅" if passes else ""} |')
    print('\nplayer-games:', {f: len(players[f]) for f in fams}, '; weak floor:', weak)
    if outp:
        json.dump({'table': table, 'examples': ex, 'player_games': {f: len(players[f]) for f in fams}}, open(outp, 'w'), indent=1)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
