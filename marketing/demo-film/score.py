"""Score, foley, voice and mix for "Ludo, explained" (v2 of the Tag Team Ludo demo film).

Reads out/events-<lang>.json (window.DUR / window.EV from the page, exported by core/render/events.mjs) and the
voice lines out/vo/<lang>/<id>.wav (core/tts/tts.py), and writes out/mix-<lang>.wav. LANG = en | hi.
Run with the library's Python from $LIB.

Three layers:
- the band (jazz bass, vibraphone, a light kit) is the app's world, steady under the whole film, and ducked under
  the voice so every word is clear;
- a chiptune square voice is Tag, the pixel mascot: it plays on every one of its moves;
- the voice says one thing per scene, compressed and about 10 dB over the music.
"""
import json, os, sys
import numpy as np, soundfile as sf

LIB = os.environ['LIB']
LANG = os.environ.get('LANG_FILM', 'en')
sys.path.insert(0, LIB)
from core.audio import sampler as S
from core.audio.sfx import SR, add, limit, whoosh, click, thump, ding, pop, brown, lp, hp, crash

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
data = json.load(open(os.path.join(OUT, f'events-{LANG}.json')))
DUR, EV = data['dur'], data['ev']
N = int((DUR + 0.6) * SR)
S.seed(7)

BPM = 112
B = 60 / BPM
bt = lambda n: n * B
NB = int(DUR / B)  # beats in the film
final_t = next((e['t'] for e in EV if e['type'] == 'final'), DUR - 5)
FINAL_B = int(round(final_t / B))

# ---------- the band: a friendly loop in F, the last chord on the mascot's landing on the logo ----------
LOOP = [('F2', ['A3', 'C4', 'E4', 'F4']), ('D2', ['A3', 'C4', 'D4', 'F4']), ('Bb1', ['A3', 'D4', 'F4']), ('C2', ['G3', 'Bb3', 'E4'])]
ev = []
for bar in range(FINAL_B // 4):
    root, voicing = LOOP[bar % 4]
    b0 = bar * 4
    r = S.midi(root)
    walk = [0, 4, 7, 9] if bar % 2 == 0 else [0, 7, 5, 4]
    for k in range(4):
        ev.append((bt(b0 + k), 'jazz_bass', r + walk[k], B * 0.9, 0.7 if k % 2 == 0 else 0.58, -0.1))
    for off in (0, 1.5):
        for p in voicing:
            ev.append((bt(b0 + off), 'vibraphone', p, B * 1.2, 0.46 if off == 0 else 0.34, 0.25))
    for k in range(8):
        ev.append((bt(b0 + k / 2), 'hihat', 'closed', None, 0.4 if k % 2 == 0 else 0.26, 0.3))
        if k in (2, 6):
            ev.append((bt(b0 + k / 2), 'snare2', 'on', None, 0.45, -0.05))
for p in ['F3', 'A3', 'C4', 'E4', 'A4']:
    ev.append((bt(FINAL_B), 'vibraphone', p, 4.5, 0.6, 0.2))
ev.append((bt(FINAL_B), 'jazz_bass', 'F1', 4.0, 0.8, -0.1))
ev.append((bt(FINAL_B), 'sus_cymbal', 'hit', None, 0.45, 0.2))
for e in EV:
    if e['type'] == 'ding':
        for i, p in enumerate(['C6', 'F6', 'A6']):
            ev.append((e['t'] + i * 0.06, 'glockenspiel', p, 1.0, 0.42, 0.3))
band = S.render(ev, dur=DUR + 0.6)
band = S.room(band, size=0.35, mix=0.16)[:N]
kick = np.zeros((N, 2), np.float32)
for b in range(0, FINAL_B, 2):
    add(kick, thump(0.8, 58), bt(b), 0.8)

# ---------- chiptune: Tag's voice, and the game's own sounds ----------
def square(freq, dur, vol=0.18, duty=0.25, slide=0.0):
    n = int(dur * SR); t = np.arange(n) / SR
    f = freq * (2 ** (slide * t / max(dur, 1e-3) / 12))
    w = np.where((np.cumsum(f) / SR % 1) < duty, 1.0, -1.0)
    env = np.minimum(1, t / 0.004) * np.exp(-t / max(dur * 0.6, 0.02))
    return (w * env * vol).astype(np.float32)
mhz = lambda m: 440 * 2 ** ((m - 69) / 12)
chip = np.zeros((N, 2), np.float32)
fol = np.zeros((N, 2), np.float32)
rng = np.random.default_rng(3)
def dice(t):  # a die rattling in a cup, then landing
    for i in range(7):
        add(fol, click(1.2 + rng.random() * 1.5, 0.35 + 0.1 * rng.random()), t + i * 0.045 + rng.random() * 0.02, 0.55, rng.uniform(-0.3, 0.3))
    add(fol, thump(0.35, 160), t + 0.36, 0.5)
for e in EV:
    t, ty = e['t'], e['type']
    if ty == 'touch' or ty == 'tap': add(fol, click(1.7, 0.45), t, 0.85, 0.1)
    elif ty == 'tick': add(fol, click(2.4, 0.3), t, 0.35)
    elif ty == 'swish': add(fol, whoosh(0.26, 0.45), t, 0.6, 0.3)
    elif ty == 'whoosh': add(fol, whoosh(0.4, 1.0), t, 0.85, -0.2)
    elif ty == 'sweep':
        add(fol, whoosh(0.45, 0.8), t, 0.6, 0)
        for i in range(6): add(chip, square(mhz(60 + i * 4), 0.05, 0.06), t + i * 0.045, 1, -0.3 + i * 0.12)
    elif ty == 'birth':
        for i, m in enumerate([72, 76, 79, 84, 88]): add(chip, square(mhz(m), 0.07, 0.09), t + i * 0.055, 1, 0)
    elif ty == 'jump': add(chip, square(mhz(79), 0.1, 0.1, slide=7), t, 1, 0)
    elif ty == 'land':
        add(chip, square(mhz(60), 0.08, 0.1, slide=-5), t, 1, 0)
        add(fol, thump(0.25, 120), t, 0.45)
    elif ty == 'step': add(chip, square(mhz(84), 0.025, 0.04, duty=0.5), t, 1, 0)
    elif ty == 'stomp':
        add(fol, thump(1.0, 52), t, 1.1); add(fol, crash(0.35), t, 0.3, 0.2)
        add(chip, square(mhz(40), 0.3, 0.16, slide=-12), t, 1, 0)
    elif ty == 'poof': add(fol, pop(0.6), t, 0.6)
    elif ty == 'coin':
        add(chip, square(mhz(83), 0.08, 0.09), t, 1, 0.2); add(chip, square(mhz(88), 0.28, 0.09), t + 0.08, 1, 0.2)
    elif ty == 'dice': dice(t)
    elif ty == 'six':
        for i, m in enumerate([72, 76, 79, 84]): add(chip, square(mhz(m), 0.09, 0.08), t + i * 0.07, 1, 0)
    elif ty == 'click': add(fol, thump(0.4, 220), t, 0.5)
    elif ty == 'kill':
        add(fol, thump(1.0, 60), t, 1.0); add(fol, crash(0.4), t, 0.35, -0.1)
        add(chip, square(mhz(55), 0.35, 0.14, slide=-12), t, 1, 0)
    elif ty == 'nope':
        add(chip, square(mhz(62), 0.12, 0.09), t, 1, 0); add(chip, square(mhz(57), 0.2, 0.09), t + 0.13, 1, 0)

# ---------- the voice ----------
VO_DIR = os.path.join(OUT, 'vo', LANG)
def env_follow(x, att=0.005, rel=0.12):
    a, r = np.exp(-1 / (att * SR)), np.exp(-1 / (rel * SR))
    e = np.zeros_like(x); v = 0.0
    ax = np.abs(x)
    for i in range(len(x)):  # fine for ~40 s of mono voice
        v = a * v + (1 - a) * ax[i] if ax[i] > v else r * v + (1 - r) * ax[i]
        e[i] = v
    return e
voice = np.zeros(N, np.float32)
for e in EV:
    if e['type'] != 'vo': continue
    f = os.path.join(VO_DIR, e['id'] + '.wav')
    if not os.path.exists(f): print('! missing voice line', f); continue
    x, sr = sf.read(f, dtype='float32')
    if x.ndim > 1: x = x.mean(1)
    if sr != SR:  # Kokoro writes 24 kHz
        n = int(len(x) * SR / sr); x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)
    i0 = int(e['t'] * SR); i1 = min(N, i0 + len(x))
    voice[i0:i1] += x[: i1 - i0]
voice = hp(voice, 80).astype(np.float32)
# gentle compression (3:1 above -20 dBFS), then level to a speech RMS
env = env_follow(voice)
thr = 10 ** (-20 / 20)
gain = np.where(env > thr, (thr * (env / thr) ** (1 / 3)) / np.maximum(env, 1e-9), 1.0)
voice = voice * gain
speech = np.abs(voice) > 1e-4
rms = np.sqrt(np.mean(voice[speech] ** 2)) if speech.any() else 1
voice = voice * (0.12 / max(rms, 1e-9))
vroom = S.room(np.stack([voice, voice], 1), size=0.2, mix=0.06)[:N]

# duck the band and kick under the voice (about -9 dB), smoothly
duck_env = env_follow(np.abs(voice), att=0.03, rel=0.35)
duck = 1 - 0.65 * np.clip(duck_env / (np.percentile(duck_env[speech], 60) if speech.any() else 1), 0, 1)
band = band * duck[:, None]; kick = kick * duck[:, None]

room = np.zeros((N, 2), np.float32)
rt = lp(brown(DUR + 0.6), 400)[:N].astype(np.float32) * 0.01
room[:, 0] = rt; room[:, 1] = np.roll(rt, 2400)

mix = band * 0.55 + kick * 0.4 + chip * 0.8 + fol * 0.85 + room + vroom
# fade out the last 0.6 s
fade = int(0.6 * SR); mix[-fade:] *= np.linspace(1, 0, fade)[:, None]
mix = np.stack([hp(mix[:, i], 28) for i in range(2)], 1)
mix = np.stack([limit(mix[:, i], 0.9) for i in range(2)], 1)
sf.write(os.path.join(OUT, f'mix-{LANG}.wav'), mix.astype(np.float32), SR, subtype='PCM_24')
print('mix', LANG, round(len(mix) / SR, 2), 's, peak', round(float(np.abs(mix).max()), 3))
