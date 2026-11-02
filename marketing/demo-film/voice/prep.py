"""Small steps of the v2 build (build.sh), in the library's Python.
  prep.py lines <lang> <out.json>   the voice lines for core/tts/tts.py, with the chosen voice (script.json "voice")
  prep.py cues <lang>               the captions from the page's events (out/events-<lang>.json) for core/render/srt.py
  prep.py counts                    how many frames each clip has (out/frames/counts.json, read by the page)
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
FILM = os.path.dirname(HERE)
OUT = os.path.join(FILM, 'out')
cmd = sys.argv[1]
if cmd == 'lines':
    lang, dest = sys.argv[2], sys.argv[3]
    s = json.load(open(os.path.join(HERE, 'script.json'), encoding='utf-8'))
    v = s['voice'][lang]
    lines = [{'id': L['id'], 'text': L['text'], 'voice': v['voice'], 'lang': v['lang'], 'speed': v['speed']} for L in s[lang]]
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    json.dump(lines, open(dest, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
elif cmd == 'cues':
    lang = sys.argv[2]
    ev = json.load(open(os.path.join(OUT, f'events-{lang}.json'), encoding='utf-8'))['ev']
    cues = [{'t0': round(e['t'], 3), 't1': round(e['t1'], 3), 'text': e['text']} for e in ev if e['type'] == 'cap']
    json.dump(cues, open(os.path.join(OUT, f'cues-{lang}.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
elif cmd == 'counts':
    d = os.path.join(OUT, 'frames')
    counts = {n: len([f for f in os.listdir(os.path.join(d, n)) if f.endswith('.jpg')]) for n in sorted(os.listdir(d)) if os.path.isdir(os.path.join(d, n))}
    json.dump(counts, open(os.path.join(d, 'counts.json'), 'w'), indent=1)
    print('frames', counts)
else:
    sys.exit(__doc__)
