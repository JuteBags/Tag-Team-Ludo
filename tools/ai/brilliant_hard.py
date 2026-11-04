"""#100 idea 2, offline: Brilliant = the move played is the 256-best (seed A, seed B agrees at 256), Hard's pick is
worse at 256 by >= T points and >= 2 SE (the spread >= T follows, so a spread filter adds nothing).
python tools/ai/brilliant_hard.py data/brilliant/native"""
import json, sys, glob, collections, os
sys.path.insert(0, os.path.dirname(__file__))
from brilliant_score import family

RULES = [(t, 0) for t in (1, 1.5, 2, 2.5, 3, 5, 8)]
per = collections.defaultdict(collections.Counter)
players = collections.defaultdict(set)
ex = collections.defaultdict(list)
for f in sorted(glob.glob(sys.argv[1] + '/*.jsonl')):
    fam = family(f)
    for line in open(f):
        r = json.loads(line)
        p = (r['seed'], r['owner'])
        players[fam].add(p)
        of, gap, se = r['of'], r['gap'], r['se']
        b = of[r['best']]
        if of[r['played']] != b or of[r['ladder']['b'][-1]] != b:
            continue
        h = of[r['hard']]
        if h == b:
            continue
        spread = max(gap)
        for (t, s) in RULES:
            if gap[h] >= t and gap[h] >= 2 * se[h] and spread >= s:
                per[fam][(p, (t, s))] += 1
                if fam == ('2p', 'extreme') and len(ex[(t, s)]) < 5:
                    ex[(t, s)].append((r['seed'], r['n'], r['moves'], round(gap[h], 2), round(se[h], 2), round(spread, 2)))
fams = [f for f in [('2p', 'extreme'), ('2p', 'normal'), ('2p', 'first'), ('2p', 'random'), ('4p', 'extreme'), ('2h-opposite', 'extreme')] if f in players]
print('| Hard\'s pick worse by | spread | ' + ' | '.join(f'{a} {b}' for a, b in fams) + ' | Extreme 2p halves |')
print('|' + '---|' * (len(fams) + 3))
for rule in RULES:
    cells = []
    for fam in fams:
        cells.append(f"{sum(per[fam][(p, rule)] for p in players[fam]) / len(players[fam]):.2f}")
    pl = players[('2p', 'extreme')]
    hv = [sum(per[('2p', 'extreme')][(p, rule)] for p in pl if p[0] % 2 == k) / max(1, sum(1 for p in pl if p[0] % 2 == k)) for k in (0, 1)]
    print(f"| ≥{rule[0]} pts & 2 SE | {'≥' + str(rule[1]) if rule[1] else 'any'} | " + ' | '.join(cells) + f" | {hv[0]:.2f} / {hv[1]:.2f} |")
print()
for rule, xs in ex.items():
    print('examples', rule, '(seed, decision, moves, Hard pick loss, se, spread):', xs)
