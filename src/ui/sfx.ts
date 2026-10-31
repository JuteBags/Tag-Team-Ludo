// Sound and haptics, all synthesised with Web Audio: no audio files, so the app stays small and offline.
// Browsers only allow audio after a user gesture, so the context is created on the first tap.

let ctx: AudioContext | null = null;
let muted = false;
try {
  muted = localStorage.getItem('ludo-muted') === '1';
} catch {
  // Storage can be blocked; sound just defaults to on.
}

function ac(): AudioContext | null {
  if (muted) return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}
// Every tap may (re)start audio: if sound was muted at the first tap and turned on later, the next
// tap is what unlocks it. ac() is cheap once the context is running.
// Not in a browser (the unit tests): no audio to unlock.
if (typeof addEventListener === 'function') addEventListener('pointerdown', () => void ac(), { capture: true, passive: true });

/** One oscillator note with a quick attack and exponential decay. */
function tone(freq: number, dur: number, { type = 'sine' as OscillatorType, vol = 0.2, at = 0, slide = 0 } = {}) {
  const a = ac();
  if (!a) return;
  const t = a.currentTime + at;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

/** A burst of filtered noise: dice clatter, impacts, whooshes. */
function noise(dur: number, { vol = 0.25, at = 0, freq = 1800, q = 0.8, type = 'bandpass' as BiquadFilterType } = {}) {
  const a = ac();
  if (!a) return;
  const t = a.currentTime + at;
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = a.createGain();
  g.gain.value = vol;
  src.connect(f).connect(g).connect(a.destination);
  src.start(t);
}

function buzz(pattern: number | number[]) {
  if (muted) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Not every WebView allows vibration.
  }
}

export const sfx = {
  get muted() {
    return muted;
  },
  setMuted(m: boolean) {
    muted = m;
    try {
      localStorage.setItem('ludo-muted', m ? '1' : '0');
    } catch {
      // Not saved; it still applies for this session.
    }
  },
  /** The die rattling in the hand and tumbling across the table. */
  roll(ms: number) {
    const n = 7;
    for (let i = 0; i < n; i++) noise(0.045, { vol: 0.16 + Math.random() * 0.1, at: (i / n) * (ms / 1000) * 0.8, freq: 1400 + Math.random() * 1800, q: 2 });
  },
  /** The die rattling inside a closed cup: muffled clacks against the walls. */
  shake(ms: number) {
    const n = 9;
    for (let i = 0; i < n; i++) noise(0.04, { vol: 0.2 + Math.random() * 0.08, at: ((i + Math.random() * 0.4) / n) * (ms / 1000), freq: 700 + Math.random() * 600, q: 3 });
    buzz([12, 50, 12, 50, 12]);
  },
  /** The die landing; a six rings out. */
  land(face: number) {
    noise(0.08, { vol: 0.32, freq: 420, q: 1.2 });
    tone(150, 0.12, { type: 'triangle', vol: 0.22 });
    buzz(18);
    if (face === 6) {
      [784, 988, 1319, 1568].forEach((f, i) => tone(f, 0.28, { type: 'triangle', vol: 0.13, at: 0.05 + i * 0.07 }));
      buzz([20, 40, 30]);
    }
  },
  /** One square of movement. */
  hop() {
    tone(520 + Math.random() * 60, 0.05, { type: 'sine', vol: 0.08 });
  },
  tick() {
    tone(880, 0.04, { type: 'square', vol: 0.04 });
  },
  /** A kill: whoosh in, heavy thud, a falling "you're out" slide. Bigger for a pair. */
  kill(n: number) {
    noise(0.18, { vol: 0.2, freq: 900, q: 0.6 });
    tone(110, 0.35, { type: 'sine', vol: 0.5, at: 0.02, slide: 0.45 });
    noise(0.25, { vol: 0.45, at: 0.02, freq: 300, q: 0.7, type: 'lowpass' });
    tone(660, 0.45, { type: 'sawtooth', vol: 0.06, at: 0.12, slide: 0.35 });
    if (n > 1) tone(82, 0.5, { type: 'sine', vol: 0.45, at: 0.14, slide: 0.5 });
    buzz(n > 1 ? [60, 40, 90] : [55, 30, 40]);
  },
  /** A token out of base. */
  release() {
    tone(392, 0.12, { type: 'triangle', vol: 0.14 });
    tone(784, 0.16, { type: 'triangle', vol: 0.12, at: 0.06 });
    buzz(14);
  },
  /** A token reaching the centre. */
  home() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.32, { type: 'triangle', vol: 0.14, at: i * 0.09 }));
    buzz([25, 40, 25, 40, 50]);
  },
  // ---------- the palace cutscene ----------
  /** The palace gate swinging open: a low wooden creak and thud. */
  gate() {
    noise(0.5, { vol: 0.22, freq: 320, q: 4 });
    tone(140, 0.5, { type: 'sawtooth', vol: 0.04, slide: 0.7 });
    tone(80, 0.3, { type: 'sine', vol: 0.3, at: 0.42 });
  },
  /** The welcome: a rising fanfare that lands on a bright chord. */
  fanfare() {
    [523, 659, 784].forEach((f, i) => tone(f, 0.18, { type: 'square', vol: 0.05, at: i * 0.11 }));
    [784, 1047, 1319].forEach((f) => tone(f, 0.8, { type: 'triangle', vol: 0.1, at: 0.36 }));
    buzz([30, 50, 30, 50, 80]);
  },
  /** Red: the guards' torches flaring up. */
  flare() {
    noise(0.6, { vol: 0.3, freq: 500, q: 0.5, type: 'lowpass' });
    tone(130, 0.5, { type: 'sawtooth', vol: 0.06, slide: 0.55 });
  },
  /** Green: a cheerful two-note whistle from the trees. */
  whistle() {
    tone(1047, 0.16, { vol: 0.1, slide: 1.25 });
    tone(1319, 0.3, { vol: 0.1, at: 0.2, slide: 1.2 });
  },
  /** Yellow: the trumpeters' call. */
  trumpets() {
    [392, 523, 659].forEach((f, i) => tone(f, 0.16, { type: 'sawtooth', vol: 0.05, at: i * 0.12 }));
    tone(784, 0.5, { type: 'sawtooth', vol: 0.05, at: 0.36 });
  },
  /** Blue: a stream of bubbles. */
  bubbles() {
    for (let i = 0; i < 9; i++) tone(280 + Math.random() * 520, 0.09, { vol: 0.08, at: i * 0.06, slide: 2.2 });
  },
  /** Three sixes: the turn is lost. */
  bust() {
    tone(330, 0.2, { type: 'square', vol: 0.07 });
    tone(220, 0.35, { type: 'square', vol: 0.07, at: 0.16, slide: 0.7 });
    buzz(120);
  },
  win() {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.5, { type: 'triangle', vol: 0.15, at: i * 0.12 }));
    buzz([40, 60, 40, 60, 120]);
  },
};
