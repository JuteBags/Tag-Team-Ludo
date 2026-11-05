// Haptics (src/ui/haptics.ts, #73): each moment's pattern, the Vibration switch, at most two moments a
// second, and a new moment replacing the rest of one still playing.
import { describe, expect, it } from 'vitest';
import { createHaptics, MAX_PER_SECOND, PATTERNS, type Clock, type Feel } from '../src/ui/haptics';

/** A hand-moved clock and a driver that records what it played, and when. */
function rig(on = () => true) {
  let t = 0;
  let timers: { at: number; f: () => void; id: number }[] = [];
  let id = 0;
  const clock: Clock = {
    now: () => t,
    later: (f, ms) => {
      timers.push({ at: t + ms, f, id: ++id });
      return id;
    },
    cancel: (x) => (timers = timers.filter((q) => q.id !== x)),
  };
  const played: { t: number; feel: Feel }[] = [];
  const h = createHaptics({ play: (feel) => played.push({ t, feel }) }, on, clock);
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      t = next.at;
      next.f();
    }
    t = end;
  };
  return { h, played, advance };
}

describe('haptics', () => {
  it('plays each moment as its pattern: a pair kill hits twice, 140 ms apart', () => {
    const { h, played, advance } = rig();
    expect(h.feel('killPair')).toBe(true);
    advance(500);
    expect(played).toEqual([
      { t: 0, feel: { impact: 'heavy' } },
      { t: 140, feel: { impact: 'heavy' } },
    ]);
  });

  it('every moment has a pattern of short steps (none waits over 300 ms)', () => {
    for (const p of Object.values(PATTERNS)) {
      expect(p.length).toBeGreaterThan(0);
      expect(p[0]!.at).toBe(0);
      for (const s of p) expect(s.at).toBeLessThanOrEqual(300);
    }
  });

  it('stays still when Vibration is off', () => {
    let on = false;
    const { h, played } = rig(() => on);
    expect(h.feel('kill')).toBe(false);
    expect(played).toEqual([]);
    on = true;
    expect(h.feel('kill')).toBe(true);
    expect(played).toHaveLength(1);
  });

  it('plays nothing (and says so) without a driver', () => {
    const h = createHaptics(null, () => true);
    expect(h.available).toBe(false);
    expect(h.feel('win')).toBe(false);
  });

  it(`never plays more than ${MAX_PER_SECOND} moments in any second, however fast the game`, () => {
    const { h, advance } = rig();
    // A burst: a 6, a release, a kill and a 6 again, 100 ms apart, then a steady stream for 5 s.
    const started: number[] = [];
    let t = 0;
    for (const m of ['six', 'release', 'kill', 'six'] as const) {
      if (h.feel(m)) started.push(t);
      advance(100);
      t += 100;
    }
    for (let k = 0; k < 50; k++) {
      if (h.feel('select')) started.push(t);
      advance(100);
      t += 100;
    }
    for (const s of started) expect(started.filter((x) => x >= s && x < s + 1000).length).toBeLessThanOrEqual(MAX_PER_SECOND);
    // And it isn't silenced for good: about two a second still get through.
    expect(started.length).toBeGreaterThanOrEqual(10);
  });

  it("a new moment replaces the rest of one still playing (a win's lights stop for a kill)", () => {
    const { h, played, advance } = rig();
    h.feel('win');
    advance(100); // the win's success has played; its lights are still to come
    h.feel('kill');
    advance(1000);
    expect(played.map((p) => p.feel)).toEqual([{ notify: 'success' }, { impact: 'heavy' }]);
  });
});
