"""Markdown table from brilliant_score.py's json. python brilliant_table.py score.json
A rule meets the target when (2p, same layout for all three columns): Extreme 0.8-2.5 per player-game with both seed
halves in that band, Normal at most half of Extreme, the weak floor (random, else first-move) at most 0.1."""
import json, sys

d = json.load(open(sys.argv[1]))
t = d['table']
cols = [('2p/extreme', 'Extreme 2p'), ('2p/normal', 'Normal 2p'), ('2p/first', 'First-move 2p'), ('2p/random', 'Random 2p'), ('4p/extreme', 'Extreme 4p'), ('2h-opposite/extreme', 'Extreme 2h')]
cols = [c for c in cols if c[0] in t]
MN = {'0/0': 'none', '1/1': '≥1 pt & 1 SE', '2/2': '≥2 pts & 2 SE', '3/2': '≥3 pts & 2 SE', '5/2': '≥5 pts & 2 SE'}
print('| N | margin | ' + ' | '.join(c[1] for c in cols) + ' | Extreme 2p halves | meets |')
print('|' + '---|' * (len(cols) + 4))
ok = []
for key in t['2p/extreme']['rules']:
    n, m, z = key.split('/')
    cells = []
    for c, _ in cols:
        r = t[c]['rules'].get(key)
        cells.append('–' if r is None else f"{r['per_player_game']:.2f}")
    e = t['2p/extreme']['rules'][key]
    nr = t.get('2p/normal', {}).get('rules', {}).get(key)
    fr = t.get('2p/random', t.get('2p/first', {})).get('rules', {}).get(key)  # the weak floor: random when logged
    band = lambda v: 0.8 <= v <= 2.5
    meets = band(e['per_player_game']) and all(band(h) for h in e['halves']) and nr is not None and nr['per_player_game'] <= 0.5 * e['per_player_game'] and fr is not None and fr['per_player_game'] <= 0.1
    if meets:
        ok.append(key)
    print(f"| {n} | {MN[m + '/' + z]} | " + ' | '.join(cells) + f" | {e['halves'][0]:.2f} / {e['halves'][1]:.2f} | {'✅' if meets else ''} |")
print()
print('rows', ' '.join(f"{c}: {t[c]['decisions']} decisions, {t[c]['player_games']} player-games" for c, _ in cols))
print('meets:', ok)
for key in ok:
    print('\nexamples 2p', key)
    for x in d['examples'].get('2p ' + key, []):
        print(' ', x)
