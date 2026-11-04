"""Sums ludo-arena's ARENA lines (from shards of one match) into one result (#166, .github/workflows/arena.yml).
  python3 tools/ai/arena_sum.py <dir with *.txt holding ARENA lines>  -> a markdown table on stdout
A's win rate (wins / games) with a 95% interval from the per-seed spread (each seed plays A in every seat), and,
when the match ran with --aivat, the luck-corrected rate (AIVAT: unbiased, much less dice noise)."""
import collections, glob, json, math, sys

rows = []
for f in sorted(glob.glob(sys.argv[1] + '/**/*.txt', recursive=True)):
    for line in open(f):
        if line.startswith('ARENA '):
            rows.append(json.loads(line[6:]))
groups = collections.defaultdict(list)
for r in rows:
    groups[(r['a'], r['b'], r['mode'], r.get('dice', 'app'))].append(r)
print('| A | B | mode | dice | seeds | games | A wins | 95% | luck-corrected | 95% | even |')
print('|---|---|---|---|---|---|---|---|---|---|---|')
for (a, b, mode, dice), rs in groups.items():
    s = sum(r['seeds'] for r in rs)
    g = sum(r['games'] for r in rs)
    p = rs[0]['people']
    w = sum(r['wins'] for r in rs)
    m = w / s  # wins per seed (out of `people` games)
    se = math.sqrt(max(sum(r['seedSq'] for r in rs) / s - m * m, 0.0) / s) / p
    cells = [f'{100 * w / g:.1f}%', f'± {196 * se:.1f}']
    if all('aivatWins' in r for r in rs):
        cw = sum(r['aivatWins'] for r in rs)
        cm = cw / s
        cse = math.sqrt(max(sum(r['aivatSeedSq'] for r in rs) / s - cm * cm, 0.0) / s) / p
        cells += [f'{100 * cw / g:.1f}%', f'± {196 * cse:.1f}']
    else:
        cells += ['–', '']
    print(f'| `{a}` | `{b}` | {mode} | {dice} | {s} | {g} | ' + ' | '.join(cells) + f' | {100 / p:.1f}% |')
