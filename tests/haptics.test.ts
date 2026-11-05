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

  it(`never plays more than ${MAX_PER_SECOND} moments in any second unless one outranks them, however fast the game`, () => {
    const { h, advance } = rig();
    // A burst that never outranks what came before (a kill, a 6, a release, a 6), 100 ms apart, then a
    // steady stream of ticks for 5 s. (A moment that outranks the recent ones still plays: the rank test.)
    const started: number[] = [];
    let t = 0;
    for (const m of ['kill', 'six', 'release', 'six'] as const) {
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
  it('a tick or a safe landing never swallows a kill, a home or a win (the rank)', () => {
    const { h, advance } = rig();
    // Select then kill within 100 ms: the kill plays.
    expect(h.feel('select')).toBe(true);
    advance(50);
    expect(h.feel('kill')).toBe(true);
    // The second is full (2 moments): a tick or a safe landing is dropped, a win still plays.
    advance(50);
    expect(h.feel('select')).toBe(false);
    expect(h.feel('safe')).toBe(false);
    expect(h.feel('win')).toBe(true);
    // Equal or lower than the win in the window: dropped.
    expect(h.feel('kill')).toBe(false);
    expect(h.feel('win')).toBe(false);
  });

  it('past the limit, a moment outranking two ticks still plays', () => {
    const { h } = rig();
    h.feel('select');
    h.feel('select');
    expect(h.feel('select')).toBe(false);
    expect(h.feel('home')).toBe(true);
  });
});
