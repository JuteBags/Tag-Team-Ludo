"""#100 full scoring, streaming (low memory). python brilliant_score.py <data/brilliant/native> <out.json>
Rule (N, M, Z): the move played is the 256-best (seed A); seed B's 256-best agrees; at both seeds n* >= N, where n* is
the smallest rung from which every rung's favourite is that move (and some lower rung disagreed); the favourite one rung
below n* (seed A) is worse at 256 by >= M points and >= Z standard errors (M = 0: no margin).
Files without "at" use the old ladder 16,32,48,64,96,128,256 (4p, 2h): scored only at N >= 32."""
import json, sys, glob, collections, os

OLD = [16, 32, 48, 64, 96, 128, 256]
NS = [8, 10, 16, 24, 30, 32, 48, 64, 96]
MARGINS = [(0, 0), (1, 1), (2, 2), (3, 2), (5, 2)]
RULES = [(n, m, z) for n in NS for (m, z) in MARGINS]


def first_stable(lad, best_c, of):
    k = len(lad)
    while k > 0 and of[lad[k - 1]] == best_c:
        k -= 1
    return k


def hits(r):
    """The rules this decision meets (and the detail for examples)."""
    of, gap, se = r['of'], r['gap'], r['se']
    at = r.get('at', OLD)
    best_c = of[r['best']]
    if of[r['played']] != best_c:
        return [], None
    la, lb = r['ladder']['a'], r['ladder']['b']
    if of[lb[-1]] != best_c:
        return [], None
    ka, kb = first_stable(la, best_c, of), first_stable(lb, best_c, of)
    if ka < 1 or kb < 1:
        return [], None
    na, nb = at[ka], at[kb]
    shallow = of[la[ka - 1]]
    g, s = gap[shallow], se[shallow]
    out = []
    for (n, m, z) in RULES:
        if 'at' not in r and n < 32:
            continue
        if na >= n and nb >= n and (m == 0 or (g >= m and g >= z * s)):
            out.append((n, m, z))
    return out, {'na': na, 'nb': nb, 'shallow_gap': g, 'shallow_se': s, 'at_below': at[ka - 1]}


def family(path):
    b = os.path.basename(path)
    for lay in ('4p', '2h-opposite', '2p'):
        if b.startswith(lay + '-'):
            return lay, b[len(lay) + 1:].split('-')[0]
    raise ValueError(b)


def main(d, outp):
    per = collections.defaultdict(lambda: collections.Counter())  # (fam) -> {(seed, owner, rule): hits}
    players = collections.defaultdict(set)
    decisions = collections.Counter()
    ex = collections.defaultdict(list)
    for f in sorted(glob.glob(d + '/*.jsonl')):
        fam = family(f)
        with open(f) as fh:
            for line in fh:
                r = json.loads(line)
                p = (r['seed'], r['owner'])
                players[fam].add(p)
                decisions[fam] += 1
                hs, det = hits(r)
                for rule in hs:
                    per[fam][(p, rule)] += 1
                    if fam[1] == 'extreme' and len(ex[(fam[0], rule)]) < 5:
                        ex[(fam[0], rule)].append({'seed': r['seed'], 'n': r['n'], 'color': r['color'], 'moves': r['moves'],
                                                    'played': r['played'], **det})
    table = {}
    for fam in players:
        pl = players[fam]
        halves = [{p for p in pl if p[0] % 2 == h} for h in (0, 1)]
        rows = {}
        for rule in RULES:
            if fam[0] != '2p' and rule[0] < 32:
                continue
            c = {p: per[fam][(p, rule)] for p in pl}
            tot = sum(c.values())
            rows['%d/%d/%d' % rule] = {
                'per_player_game': tot / len(pl),
                'halves': [sum(c[p] for p in hp) / max(1, len(hp)) for hp in halves],
                'share_with_any': sum(1 for p in pl if c[p]) / len(pl),
                'hits': tot,
            }
        table['%s/%s' % fam] = {'decisions': decisions[fam], 'player_games': len(pl), 'rules': rows}
    json.dump({'table': table, 'examples': {'%s %d/%d/%d' % ((k[0],) + k[1]): v for k, v in ex.items()}}, open(outp, 'w'), indent=1)
    print('wrote', outp, {k: (v['decisions'], v['player_games']) for k, v in table.items()})


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
