"""The Hindi voice-over with Chatterbox (multilingual, MIT), cleaned line by line. Run on CI (build.sh, VO_ENGINE=chatterbox).

Chatterbox sounds the most human in Hindi, but after a line it sometimes keeps going: a mumble, a repeated
syllable or noise. So for every line it:
1. makes several takes (different seeds);
2. transcribes each take with Whisper (faster-whisper, Hindi) with word timings;
3. finds where the take has said the whole script line (the word where the transcript best matches the line)
   and cuts there, so anything said after the line is dropped;
4. keeps the take whose words match the script best.

Writes out/vo/<lang>/<id>.wav and dur.json, the same layout as core/tts/tts.py, plus takes.json (scores).
Usage: python chatterbox_vo.py <lang> [takes]   (lang: hi; the script is voice/script.json)
"""
import difflib, json, os, re, sys

import numpy as np
import soundfile as sf
import torch

LANG = sys.argv[1] if len(sys.argv) > 1 else 'hi'
TAKES = int(sys.argv[2]) if len(sys.argv) > 2 else 4
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), 'out', 'vo', LANG)
os.makedirs(OUT, exist_ok=True)
script = json.load(open(os.path.join(HERE, 'script.json'), encoding='utf-8'))[LANG]

norm = lambda s: re.sub(r'[\s\.,!?।"\'’‘“”\-–—:;()]+', '', s)
score = lambda a, b: difflib.SequenceMatcher(None, norm(a), norm(b)).ratio()

from faster_whisper import WhisperModel  # noqa: E402
from chatterbox.mtl_tts import ChatterboxMultilingualTTS  # noqa: E402

asr = WhisperModel('small', device='cpu', compute_type='int8')
tts = ChatterboxMultilingualTTS.from_pretrained(device='cpu')
SR = tts.sr


def best_cut(wav_path, line):
    """Where to cut a take, and how well its words match the line (0..1)."""
    segs, _ = asr.transcribe(wav_path, language=LANG, word_timestamps=True, vad_filter=False, beam_size=5)
    words = [w for s in segs for w in (s.words or [])]
    if not words:
        return None, 0.0, ''
    best_i, best = 0, -1.0
    text = ''
    for i, w in enumerate(words):
        text += w.word
        r = score(text, line)
        if r > best + 1e-6:
            best_i, best = i, r
    said = ''.join(w.word for w in words[: best_i + 1])
    return words[best_i].end, best, said


report, dur = {}, {}
for L in script:
    takes = []
    for k in range(TAKES):
        torch.manual_seed(1000 + k)
        wav = tts.generate(L['text'], language_id=LANG, exaggeration=0.5, cfg_weight=0.5, temperature=0.75)
        x = wav.squeeze().cpu().numpy().astype(np.float32)
        tmp = os.path.join(OUT, f"{L['id']}.take{k}.wav")
        sf.write(tmp, x, SR)
        end, r, said = best_cut(tmp, L['text'])
        if end is None:
            continue
        cut = min(len(x), int((end + 0.14) * SR))
        y = x[:cut]
        nz = np.where(np.abs(y) > np.abs(y).max() * 0.02)[0]   # trim the lead-in silence
        if len(nz):
            y = y[max(0, nz[0] - int(0.03 * SR)):]
        fade = min(len(y), int(0.03 * SR))
        y[-fade:] *= np.linspace(1, 0, fade)                    # no click at the cut
        takes.append({'k': k, 'score': round(r, 3), 'said': said, 'cut_s': round(end, 2), 'raw_s': round(len(x) / SR, 2), 'y': y})
        print(L['id'], 'take', k, 'match', round(r, 3), 'cut at', round(end, 2), 'of', round(len(x) / SR, 2), 's', flush=True)
    if not takes:
        sys.exit(f"chatterbox_vo: no usable take for line {L['id']}")
    # best match first; among near-equal matches (within 0.02), the shorter, cleaner take
    top = max(t['score'] for t in takes)
    pick = min((t for t in takes if t['score'] >= top - 0.02), key=lambda t: len(t['y']))
    sf.write(os.path.join(OUT, L['id'] + '.wav'), pick['y'], SR)
    dur[L['id']] = round(len(pick['y']) / SR, 3)
    report[L['id']] = {'picked': pick['k'], 'takes': [{k: v for k, v in t.items() if k != 'y'} for t in takes]}
    for k in range(TAKES):
        p = os.path.join(OUT, f"{L['id']}.take{k}.wav")
        if os.path.exists(p):
            os.remove(p)
json.dump(dur, open(os.path.join(OUT, 'dur.json'), 'w'), indent=1)
json.dump(report, open(os.path.join(OUT, 'takes.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
low = {i: r['takes'][[t['k'] for t in r['takes']].index(r['picked'])]['score'] for i, r in report.items()}
print('picked match per line:', low)
