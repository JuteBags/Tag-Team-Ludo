// Sound (src/ui/sfx.ts, #98): the AudioContext sleeps when nothing plays, and the next sound wakes it
// without losing the note.
import { beforeAll, describe, expect, it, vi } from 'vitest';

/** A fake AudioContext: a clock we move by hand, and what was started, suspended and resumed. */
class FakeContext {
  static last: FakeContext;
  state: 'running' | 'suspended' = 'running';
  currentTime = 0;
  sampleRate = 8000;
  destination = {};
  started: number[] = [];
  suspends = 0;
  resumes = 0;
  constructor() {
    FakeContext.last = this;
  }
  suspend() {
    this.suspends++;
    this.state = 'suspended';
    return Promise.resolve();
  }
  resume() {
    this.resumes++;
    this.state = 'running';
    return Promise.resolve();
  }
  private node() {
    const ctx = this;
    const param = { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} };
    const n = {
      type: '',
      buffer: null,
      frequency: param,
      gain: param,
      Q: param,
      connect: () => n,
      start: (t: number) => ctx.started.push(t),
      stop() {},
    };
    return n;
  }
  createOscillator = () => this.node();
  createGain = () => this.node();
  createBiquadFilter = () => this.node();
  createBufferSource = () => this.node();
  createBuffer = (_c: number, len: number) => ({ getChannelData: () => new Float32Array(len) });
}

let hide: () => void = () => {};
const doc = { hidden: false, addEventListener: (type: string, f: () => void) => type === 'visibilitychange' && (hide = f) };
let sfx: typeof import('../src/ui/sfx').sfx;

beforeAll(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { AudioContext: FakeContext });
  vi.stubGlobal('document', doc);
  ({ sfx } = await import('../src/ui/sfx'));
});

describe('sound', () => {
  it('sleeps 5 s after the last sound ends, and wakes for the next one without losing it', () => {
    sfx.land(3);
    const a = FakeContext.last;
    expect(a.started.length).toBeGreaterThan(0);
    // The sound is still playing at 5 s (context time hasn't passed its end): no sleep yet.
    a.currentTime = 0.01;
    vi.advanceTimersByTime(5000);
    expect(a.suspends).toBe(0);
    // Its end has passed: the next check puts the context to sleep.
    a.currentTime = 10;
    vi.advanceTimersByTime(5000);
    expect(a.suspends).toBe(1);
    expect(a.state).toBe('suspended');
    // The next sound resumes it and is still scheduled.
    const before = a.started.length;
    sfx.land(4);
    expect(a.resumes).toBe(1);
    expect(a.started.length).toBeGreaterThan(before);
  });

  it("doesn't drop the first sound after a sleep: its notes start at the clock where the context resumes", () => {
    const a = FakeContext.last;
    sfx.land(5);
    a.currentTime = 20;
    vi.advanceTimersByTime(5000);
    expect(a.state).toBe('suspended');
    // A suspended context's clock stands still (Web Audio spec), and resuming carries on from it. The next
    // sound is scheduled while it's still suspended, at that clock, so it starts as soon as it runs: no
    // await needed, and nothing is scheduled in the past.
    const n = a.started.length;
    sfx.land(6);
    expect(a.state).toBe('running');
    const notes = a.started.slice(n);
    expect(notes.length).toBeGreaterThan(0);
    expect(Math.min(...notes)).toBeGreaterThanOrEqual(20);
  });

  it('measured: after one dice sound, the context runs about 5 s of a 60 s idle minute (it ran all 60 before #98)', () => {
    const a = FakeContext.last;
    const t0 = 100;
    a.currentTime = t0;
    sfx.land(1);
    let running = 0;
    for (let s = 1; s <= 60; s++) {
      a.currentTime = t0 + s; // the context's clock, which only moves while it runs; here it stands for wall time
      vi.advanceTimersByTime(1000);
      if (a.state === 'running') running++;
    }
    console.log(`idle minute after one sound: AudioContext running ${running} s of 60`);
    expect(running).toBeLessThanOrEqual(6);
  });

  it('sleeps at once when the app is hidden', () => {
    const a = FakeContext.last;
    sfx.land(2);
    expect(a.state).toBe('running');
    doc.hidden = true;
    hide();
    expect(a.state).toBe('suspended');
    doc.hidden = false;
  });
});
