"""Chatterbox auditions (Resemble AI, MIT): a more natural open model, and the one that can later take the
owner's own voice from a short reference clip. English with the English model, Hindi with the multilingual
one, both on their default voice. CPU on a runner is slow but fine for seven lines.
Writes out/samples/<lang>-chatterbox.mp3."""
import json, os, subprocess

import torchaudio as ta

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
script = json.load(open(os.path.join(HERE, 'script.json'), encoding='utf-8'))
os.makedirs(os.path.join(OUT, 'samples'), exist_ok=True)


def read(lang, gen, sr):
    d = os.path.join(OUT, 'lines', f'{lang}-chatterbox')
    os.makedirs(d, exist_ok=True)
    files = []
    for L in script[lang]:
        f = os.path.join(d, L['id'] + '.wav')
        ta.save(f, gen(L['text']), sr)
        files.append(f)
        print(lang, L['id'], 'done', flush=True)
    parts = sum((['-i', f] for f in files), [])
    n = len(files)
    chain = ''.join(f'[{i}:a]apad=pad_dur=0.45[a{i}];' for i in range(n)) + ''.join(f'[a{i}]' for i in range(n))
    chain += f'concat=n={n}:v=0:a=1,loudnorm=I=-16:TP=-1.5[out]'
    mp3 = os.path.join(OUT, 'samples', f'{lang}-chatterbox.mp3')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', *parts, '-filter_complex', chain, '-map', '[out]', '-ar', '44100', '-b:a', '128k', mp3], check=True)


from chatterbox.tts import ChatterboxTTS  # noqa: E402

en = ChatterboxTTS.from_pretrained(device='cpu')
read('en', lambda t: en.generate(t, exaggeration=0.5, cfg_weight=0.5), en.sr)
del en

from chatterbox.mtl_tts import ChatterboxMultilingualTTS  # noqa: E402

mt = ChatterboxMultilingualTTS.from_pretrained(device='cpu')
read('hi', lambda t: mt.generate(t, language_id='hi'), mt.sr)
