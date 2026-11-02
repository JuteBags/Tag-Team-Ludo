"""Score, foley and mix for "The One Move" (Tag Team Ludo demo). Reads events.json (window.DUR / window.EV from the
page, exported by core/render/events.mjs) and writes out/mix.wav. Run with the library's Python from $LIB.

Two resolutions in the music (STYLE.md §7): a hi-fi band (jazz bass, vibraphone, glockenspiel, a kit) is the app's
world; a chiptune square voice is Tag, the pixel mascot, and it plays on every one of its moves.
"""
import json, os, sys
import numpy as np, soundfile as sf

LIB = os.environ['LIB']
sys.path.insert(0, LIB)
from core.audio import sampler as S
from core.audio.sfx import SR, add, limit, whoosh, click, thump, ding, pop, brown, lp, hp, crash

HERE = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(HERE, 'events.json')))
DUR = data['dur']
EV = data['ev']
N = int((DUR + .5) * SR)
S.seed(7)

BPM = 112
B = 60 / BPM            # one beat
bt = lambda n: n * B    # beat number → seconds

# ---------- harmony on the grid (beats) ----------
# Play (F major), Review (D minor), Best move (F major), Win (F major, hook), final chord on beat 60.
PROG = []
def section(b0, b1, chords):
    b, i = b0, 0
    while b < b1:
        PROG.append((b, min(b + 4, b1), chords[i % len(chords)])); b += 4; i += 1
section(0, 18, [('F2', ['A3', 'C4', 'E4', 'F4']), ('D2', ['A3', 'C4', 'D4', 'F4']), ('Bb1', ['A3', 'D4', 'F4']), ('C2', ['G3', 'Bb3', 'E4'])])
section(18, 31, [('D2', ['F3', 'A3', 'D4']), ('Bb1', ['F3', 'A3', 'D4']), ('G1', ['G3', 'Bb3', 'D4']), ('A1', ['G3', 'C#4', 'E4'])])
section(32, 50, [('F2', ['A3', 'C4', 'E4']), ('Bb1', ['A3', 'D4', 'F4']), ('G2', ['A3', 'Bb3', 'D4', 'F4']), ('C2', ['G3', 'Bb3', 'E4'])])
section(50, 60, [('F2', ['A3', 'C4', 'F4']), ('C2', ['G3', 'C4', 'E4']), ('D2', ['A3', 'D4', 'F4'])])

def chord_at(b):
    for b0, b1, c in PROG:
        if b0 <= b < b1: return c
    return ('F2', ['A3', 'C4', 'F4'])

ev = []   # sampler events (t, inst, pitch, dur, vel, pan)
# bass
for b0, b1, (root, _) in PROG:
    r = S.midi(root)
    if 18 <= b0 < 31:   # review: half notes
        for k in range(int(b1 - b0) // 2): ev.append((bt(b0 + 2 * k), 'jazz_bass', r + (0 if k % 2 == 0 else 7), 2 * B * .95, .7, -.1))
    else:               # walking
        walk = [0, 4, 7, 9] if (b0 // 4) % 2 == 0 else [0, 7, 5, 4]
        for k in range(int(b1 - b0)): ev.append((bt(b0 + k), 'jazz_bass', r + walk[k % 4], B * .9, .72 if k % 2 == 0 else .6, -.1))
# vibraphone comping (on 1 and the "and" of 2), sustained in the review
for b0, b1, (_, voicing) in PROG:
    if 18 <= b0 < 31:
        for p in voicing: ev.append((bt(b0), 'vibraphone', p, (b1 - b0) * B * .95, .42, .25))
    else:
        for off in (0, 1.5):
            if b0 + off < b1:
                for p in voicing: ev.append((bt(b0 + off), 'vibraphone', p, B * 1.2, .5 if off == 0 else .38, .25))
# kit
def kit(b0, b1, full=True, claps=False):
    for k in range(int((b1 - b0) * 2)):
        b = b0 + k / 2
        ev.append((bt(b), 'hihat', 'closed', None, .45 if k % 2 == 0 else .3, .3))
        if not full: continue
        if (b - b0) % 2 == 1: ev.append((bt(b), 'snare2', 'on' if not claps else 'off', None, .55, -.05))
        if claps and (b - b0) % 2 == 1: ev.append((bt(b), 'claps', 'group', None, .5, .1))
kit(0, 16, True)
for k, v in enumerate(['high', 'high', 'low', 'low']):   # tom fill into the chapter wipe
    ev.append((bt(16 + k * .5), 'toms', v, None, .6, -.3 + k * .2))
kit(18, 30, full=False)
kit(32, 50, True)
kit(50, 60, True, claps=True)
ev.append((26.95, 'sus_cymbal', 'hit', None, .6, .2))
ev.append((9.55, 'sus_cymbal', 'hit', None, .45, -.2))
# glockenspiel on the BEST point and the reveal, and the last chord
for t, notes in [(21.2, ['C6', 'F6', 'A6']), (25.0, ['A5', 'C6', 'F6'])]:
    for i, p in enumerate(notes): ev.append((t + i * .07, 'glockenspiel', p, 1.2, .55, .3))
for p in ['F3', 'A3', 'C4', 'E4', 'A4']: ev.append((bt(60), 'vibraphone', p, 3.2, .6, .2))
ev.append((bt(60), 'jazz_bass', 'F1', 3.0, .8, -.1))
ev.append((bt(60), 'sus_cymbal', 'hit', None, .5, .2))

band = S.render(ev, dur=DUR + .5)
band = S.room(band, size=.35, mix=.16)

# synthesized kick (the sample library's bass drum is orchestral)
kick = np.zeros((N, 2), np.float32)
def kickhit(at, v=.9): add(kick, thump(v, 58), at, .9)
for b in list(range(0, 16, 2)) + list(range(32, 50, 2)) + list(range(50, 60, 1)): kickhit(bt(b))

# silence before the stomp: nothing but room tone between 16.6 and 17.14
def duck(x, a, b, fade=.06):
    i0, i1 = int(a * SR), int(b * SR); f = int(fade * SR)
    g = np.ones(len(x)); g[i0:i1] = 0
    g[max(0, i0 - f):i0] = np.linspace(1, 0, min(f, i0))
    return x * g[:, None]
band = duck(band[:N], 16.6, bt(32) - .01)
kick = duck(kick, 16.6, bt(32) - .01)

# ---------- chiptune: Tag's voice ----------
def square(freq, dur, vol=.18, duty=.25, slide=0.0):
    n = int(dur * SR); t = np.arange(n) / SR
    f = freq * (2 ** (slide * t / max(dur, 1e-3) / 12))
    ph = np.cumsum(f) / SR
    w = np.where((ph % 1) < duty, 1.0, -1.0)
    env = np.minimum(1, t / .004) * np.exp(-t / max(dur * .6, .02))
    return (w * env * vol).astype(np.float32)
hz = lambda p: 440 * 2 ** ((S.midi(p) - 69) / 12)
chip = np.zeros((N, 2), np.float32)
def chord_tone(t, idx):
    _, v = chord_at(t / B)
    return S.midi(v[idx % len(v)]) + 12
def mhz(m): return 440 * 2 ** ((m - 69) / 12)
# the hook in the win section (square lead trading with the band)
hook = [(50, 'C6', .5), (50.5, 'A5', .5), (51, 'F5', .5), (52, 'G5', 1), (54, 'E5', .5), (54.5, 'G5', .5), (55, 'C6', 1),
        (56, 'D6', .5), (56.5, 'C6', .5), (57, 'A5', 1), (58, 'F5', .5), (58.5, 'G5', .5), (59, 'A5', 1)]
for b, p, d in hook: add(chip, square(hz(p), d * B * .9, .1), bt(b), 1, .15)
for b in np.arange(26, 31, .5):   # review: a rising chip arpeggio builds toward the stomp
    add(chip, square(mhz(chord_tone(bt(b), int((b - 26) * 2)) + 12), .09, .05), bt(b), 1, -.2)

# ---------- foley from the page's events ----------
fol = np.zeros((N, 2), np.float32)
for e in EV:
    t, ty = e['t'], e['type']
    if ty == 'touch': add(fol, click(1.7, .45), t, .9, .1)
    elif ty == 'swish': add(fol, whoosh(.26, .45), t, .6, .3)
    elif ty == 'whoosh': add(fol, whoosh(.4, 1.0), t, .9, -.2)
    elif ty == 'sweep':
        add(fol, whoosh(.45, .8), t, .7, 0)
        for i in range(6): add(chip, square(mhz(60 + i * 4), .05, .06), t + i * .045, 1, -.3 + i * .12)
    elif ty == 'birth':
        for i, m in enumerate([72, 76, 79, 84, 88]): add(chip, square(mhz(m), .07, .09), t + i * .055, 1, 0)
    elif ty == 'jump': add(chip, square(mhz(chord_tone(t, 2)), .1, .1, slide=7), t, 1, 0)
    elif ty == 'land':
        add(chip, square(mhz(chord_tone(t, 0) - 12), .08, .1, slide=-5), t, 1, 0)
        add(fol, thump(.25, 120), t, .5)
    elif ty == 'step': add(chip, square(mhz(84), .025, .04, duty=.5), t, 1, 0)
    elif ty == 'stomp':
        add(fol, thump(1.0, 52), t, 1.2)
        add(fol, crash(.35), t, .35, .2)
        add(chip, square(mhz(40), .3, .16, slide=-12), t, 1, 0)
    elif ty == 'poof': add(fol, pop(.6), t, .6)
    elif ty == 'ding': add(fol, ding(.5), t, .45, .3)
    elif ty == 'coin':
        add(chip, square(mhz(83), .08, .09), t, 1, .2); add(chip, square(mhz(88), .28, .09), t + .08, 1, .2)

room = np.zeros((N, 2), np.float32)
rt = lp(brown(DUR + .5), 400)[:N].astype(np.float32) * .012
room[:, 0] = rt; room[:, 1] = np.roll(rt, 2400)

mix = band[:N] * .8 + kick * .55 + chip * .9 + fol * .9 + room
mix = np.stack([hp(mix[:, i], 28) for i in range(2)], 1)
mix = np.stack([limit(mix[:, i], .9) for i in range(2)], 1)
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR, subtype='PCM_24')
print('mix', round(len(mix) / SR, 2), 's peak', round(float(np.abs(mix).max()), 3))
