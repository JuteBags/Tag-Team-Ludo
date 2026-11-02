"""Voice auditions for the demo film (run on CI: .github/workflows/voice-samples.yml).
Reads script.json and renders the whole script once per candidate voice with the library's Kokoro tool
($LIB/core/tts/tts.py), then joins each read into one MP3 with a breath between lines, so a person can listen
and pick. Writes out/samples/<lang>-<voice>.mp3 and out/samples/index.json."""
import json, os, subprocess, sys

LIB = os.environ['LIB']
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
script = json.load(open(os.path.join(HERE, 'script.json'), encoding='utf-8'))
# Kokoro v1.0: the strongest English voices (American a*, British b*), and all four Hindi ones.
CAST = {
    'en': {'speed': 0.95, 'voices': ['af_heart', 'af_bella', 'am_michael', 'am_fenrir', 'bf_emma', 'bm_george']},
    'hi': {'speed': 0.92, 'voices': ['hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi']},
}
GAP = 0.45  # seconds between lines


def lang_of(lang, voice):
    if lang == 'hi':
        return 'hi'
    return 'en-gb' if voice.startswith('b') else 'en-us'


def join(files, mp3):
    """The lines in order, a breath after each, levelled to -16 LUFS (a speech level for listening)."""
    parts = sum((['-i', f] for f in files), [])
    n = len(files)
    chain = ''.join(f'[{i}:a]apad=pad_dur={GAP}[a{i}];' for i in range(n)) + ''.join(f'[a{i}]' for i in range(n))
    chain += f'concat=n={n}:v=0:a=1,loudnorm=I=-16:TP=-1.5[out]'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', *parts, '-filter_complex', chain, '-map', '[out]', '-ar', '44100', '-b:a', '128k', mp3], check=True)


index = []
os.makedirs(os.path.join(OUT, 'samples'), exist_ok=True)
for lang, cast in CAST.items():
    for v in cast['voices']:
        d = os.path.join(OUT, 'lines', f'{lang}-{v}')
        os.makedirs(d, exist_ok=True)
        lines = [{**L, 'voice': v, 'lang': lang_of(lang, v), 'speed': cast['speed']} for L in script[lang]]
        lj = os.path.join(d, 'lines.json')
        json.dump(lines, open(lj, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        r = subprocess.run([sys.executable, os.path.join(LIB, 'core/tts/tts.py'), lj, d], capture_output=True, text=True)
        print(f'== {lang}-{v}\n{r.stdout[-1500:]}{r.stderr[-1500:]}')
        if r.returncode:
            print(f'! {lang}-{v} failed')
            continue
        mp3 = os.path.join(OUT, 'samples', f'{lang}-{v}.mp3')
        join([os.path.join(d, L['id'] + '.wav') for L in lines], mp3)
        dur = json.load(open(os.path.join(d, 'dur.json')))
        index.append({'file': os.path.basename(mp3), 'engine': 'Kokoro', 'lang': lang, 'voice': v, 'speech_s': round(sum(dur.values()), 1)})
json.dump(index, open(os.path.join(OUT, 'samples', 'index-kokoro.json'), 'w'), indent=1)
print(json.dumps(index, indent=1))
if not index:
    sys.exit('no voice rendered')
