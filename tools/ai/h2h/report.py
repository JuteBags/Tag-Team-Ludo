"""The head-to-head report (#148): python report.py <results dir> -> markdown on stdout.
Per match: games, A's wins with a 95% Wilson interval and a paired one (by deal: the same dice with each side in
each seat), what even is (2p 50%, 4p lone side 25%), games cut by the roll cap, time per game and per decision."""
import collections, glob, json, math, sys

CITATION = ('Sumit Pal. "How a small network got strong." AlphaLudo V17: a 588K-parameter graph transformer for two- '
            'and four-player Ludo, 2026. https://alphaludo.in/research/')


def wilson(k, n, z=1.96):
    if n == 0:
        return (float('nan'),) * 2
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return c - h, c + h


rows = [json.loads(l) for f in sorted(glob.glob(sys.argv[1] + '/**/*.jsonl', recursive=True)) for l in open(f) if l.strip()]
groups = collections.defaultdict(list)
for r in rows:
    groups[(r['layout'], r['a'], r['b'], r['to_end'], r.get('nmax', 128))].append(r)
print('| match | games | A wins | 95% (Wilson) | 95% (paired by deal) | even | cut | s / game | ms / decision A · B |')
print('|---|---|---|---|---|---|---|---|---|')
for (layout, a, b, to_end, nmax), rs in sorted(groups.items()):
    n = len(rs)
    k = sum(r['a_won'] for r in rs)
    lo, hi = wilson(k, n)
    deals = collections.defaultdict(list)
    for r in rs:
        deals[r['deal']].append(r['a_won'])
    means = [sum(v) / len(v) for v in deals.values()]
    m = sum(means) / len(means)
    se = math.sqrt(sum((x - m) ** 2 for x in means) / max(1, len(means) - 1) / len(means))
    even = '50%' if layout == '2p' else '25%'
    title = f"{layout}: {'1 ' if layout == '4p' else ''}{a} vs {'3 ' if layout == '4p' else ''}{b}" + (f' ({nmax} playouts)' if nmax != 128 else '') + (' (to the end)' if to_end else '')
    msa = sum(r['ms'][0] for r in rs) / max(1, sum(r['dec'][0] for r in rs))
    msb = sum(r['ms'][1] for r in rs) / max(1, sum(r['dec'][1] for r in rs))
    print(f"| {title} | {n} | {100 * k / n:.1f}% | {100 * lo:.1f}–{100 * hi:.1f}% | {100 * (m - 1.96 * se):.1f}–{100 * (m + 1.96 * se):.1f}% | {even} "
          f"| {sum(r['cut_short'] for r in rs)} | {sum(r['game_s'] for r in rs) / n:.1f} | {msa:.0f} · {msb:.0f} |")
print("\n**By seat** (A's wins with A in each seat; seat 0 moves first):\n")
for (layout, a, b, to_end, nmax), rs in sorted(groups.items()):
    by = collections.defaultdict(lambda: [0, 0])
    for r in rs:
        by[r['a_seat']][0] += r['a_won']
        by[r['a_seat']][1] += 1
    print(f"- {layout} {a} vs {b}{f' ({nmax} playouts)' if nmax != 128 else ''}: " + ', '.join(f"seat {s} {w}/{n} ({100 * w / n:.0f}%)" for s, (w, n) in sorted(by.items())))
print(f'\nCitation: {CITATION}')
