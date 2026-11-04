"""#100 diagnostics: why the first-move control scores Brilliants. python brilliant_diag.py <dir>"""
import json, sys, glob, collections, os
sys.path.insert(0, os.path.dirname(__file__))
from brilliant_score import hits, family
R = (32, 1, 1)
agg = collections.defaultdict(collections.Counter)
for f in sorted(glob.glob(sys.argv[1] + '/2p-*.jsonl')):
    fam = family(f)[1]
    for line in open(f):
        r = json.loads(line); of = r['of']; c = agg[fam]
        k = len(set(of)); c['dec'] += 1; c['k%d' % min(k, 4)] += 1
        best = of[r['best']] == of[r['played']]; c['best'] += best
        c['p0best'] += of[r['best']] == of[0]
        hs, _ = hits(r); h = R in hs
        c['hit'] += h; c['hit_k%d' % min(k, 4)] += h
        hard_best = of[r['hard']] == of[r['best']]
        c['hit_hardmiss'] += h and not hard_best
        c['hardmiss'] += not hard_best
for fam, c in agg.items():
    d = c['dec']
    print(fam, f"decisions {d}; played best {c['best']/d:.1%}; move 0 is best {c['p0best']/d:.1%}; Hard misses best {c['hardmiss']/d:.1%}")
    print('   candidates 2/3/4+:', ' '.join(f"{c['k%d'%k]/d:.0%}" for k in (2,3,4)), '| rule 32/1/1 hits per decision by candidates:', ' '.join(f"{c['hit_k%d'%k]/max(1,c['k%d'%k]):.2%}" for k in (2,3,4)),
          f"| hits where Hard also misses: {c['hit_hardmiss']}/{c['hit']}")
