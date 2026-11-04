"""#100 idea 3, counter-intuitive: the move played is the 256-best (seed B agrees), it beats the second-best move by
>= T points and >= 2 SE (T = 0: no margin), and a simple rule would call it bad. The facts come from a replay of the
same games (ludo-brilliant --facts 1, data/brilliant/facts), joined by (layout, study, seed, n):
  declines   it captures nothing while another legal move captures
  exposed    the moved token ends in danger >= 10% (reviewWhy.ts dangerAt, native)
  back       it moves the back token while a more advanced token could move
  breaks     it moves one token off a pair of yours on a normal square
  any        any of the four
python tools/ai/brilliant_counter.py data/brilliant/native data/brilliant/facts [out.json]"""
import json, sys, glob, collections, os

sys.path.insert(0, os.path.dirname(__file__))
from brilliant_score import family

TAGS = ['declines', 'exposed', 'back', 'breaks', 'any']
TS = [0, 1, 2, 3, 5]


def tags(f, i):
    cap, danger, back, brk = f[i]
    t = {'declines': not cap and any(o[0] for o in f), 'exposed': danger >= 0.1, 'back': bool(back), 'breaks': bool(brk)}
    t['any'] = any(t.values())
    return t


def main(nd, fd, outp=None):
    facts = {}
    for f in glob.glob(fd + '/*.jsonl'):
        for line in open(f):
            r = json.loads(line)
            facts[(r['layout'], r['study'], r['seed'], r['n'])] = r
    per = collections.defaultdict(collections.Counter)
    players = collections.defaultdict(set)
    ex = collections.defaultdict(list)
    missing = mismatch = 0
    for f in sorted(glob.glob(nd + '/*.jsonl')):
        lay, study = family(f)
        fam = f'{lay}/{study}'
        for line in open(f):
            r = json.loads(line)
            fr = facts.get((r['layout'], r['study'], r['seed'], r['n']))
            if fr is None:
                missing += 1
                continue
            p = (r['seed'], r['owner'])
            players[fam].add(p)
            if fr['moves'] != r['moves'] or fr['played'] != r['played']:
                mismatch += 1
                continue
            of, gap, se = r['of'], r['gap'], r['se']
            b = of[r['best']]
            if of[r['played']] != b or of[r['ladder']['b'][-1]] != b:
                continue
            second = min((c for c in set(of) if c != b), key=lambda c: gap[c])
            g, s = gap[second], se[second]
            tg = tags(fr['f'], r['played'])
            for tag in TAGS:
                if not tg[tag]:
                    continue
                for t in TS:
                    if t == 0 or (g >= t and g >= 2 * s):
                        per[fam][(p, (tag, t))] += 1
                        if fam == '2p/extreme' and len(ex[f'{tag} {t}']) < 5:
                            ex[f'{tag} {t}'].append({'seed': r['seed'], 'n': r['n'], 'moves': r['moves'], 'win': round(100 * r['mean'][b], 1),
                                                     'second_gap': g, 'second_se': s, 'tags': [k for k in TAGS[:4] if tg[k]]})
    fams = [f for f in ['2p/extreme', '2p/normal', '2p/first', '2p/random'] if f in players]
    weak = '2p/random' if '2p/random' in players else '2p/first'
    print(f'joined; {missing} decisions without facts, {mismatch} replay mismatches')
    print('| counter-intuitive | beats the 2nd-best by | ' + ' | '.join(fams) + ' | Extreme 2p halves | passes |')
    print('|' + '---|' * (len(fams) + 4))
    table = {}
    for tag in TAGS:
        for t in TS:
            rule = (tag, t)
            rate = lambda fam, sel=lambda p: True: (lambda ps: sum(per[fam][(p, rule)] for p in ps) / max(1, len(ps)))([p for p in players[fam] if sel(p)])
            vals = {fam: rate(fam) for fam in fams}
            halves = [rate('2p/extreme', lambda p, k=k: p[0] % 2 == k) for k in (0, 1)]
            e = vals['2p/extreme']
            band = lambda v: 0.8 <= v <= 2.5
            passes = band(e) and all(band(h) for h in halves) and vals.get('2p/normal', 9) <= 0.5 * e and vals.get(weak, 9) <= 0.1
            table[f'{tag} {t}'] = {'rates': vals, 'halves': halves, 'passes': passes}
            print(f"| {tag} | {'any margin' if t == 0 else f'≥{t} pts & 2 SE'} | " + ' | '.join(f'{vals[f]:.2f}' for f in fams) + f' | {halves[0]:.2f} / {halves[1]:.2f} | {"✅" if passes else ""} |')
    print('\nplayer-games:', {f: len(players[f]) for f in fams}, '; weak floor:', weak)
    if outp:
        json.dump({'table': table, 'examples': ex}, open(outp, 'w'), indent=1)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
