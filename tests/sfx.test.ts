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
