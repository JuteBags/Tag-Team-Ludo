// The daily check-in's rules (src/ui/checkin.ts): the 7-day track, streaks, a missed day, the clock moved back.
import { describe, expect, it } from 'vitest';
import { CHECKIN_GOLD, collect, dayKey, due } from '../src/ui/checkin';

describe('daily check-in', () => {
  it('pays day 1 on the first open, and nothing more that day', () => {
    expect(due(null, '2026-11-01')).toEqual({ streak: 1, day: 1, gold: 20 });
    const c = collect(null, '2026-11-01');
    expect(c).toEqual({ last: '2026-11-01', streak: 1, best: 1 });
    expect(due(c, '2026-11-01')).toBeNull();
  });

  it('grows along the week and repeats after day 7, across month and year ends', () => {
    let c = collect(null, '2026-12-28');
    const days = ['2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04'];
    const gold = days.map((d) => {
      const g = due(c, d)!.gold;
      c = collect(c, d);
      return g;
    });
    expect(gold).toEqual([...CHECKIN_GOLD.slice(1), CHECKIN_GOLD[0]]);
    expect(c.streak).toBe(8);
    expect(due(c, '2027-01-05')).toEqual({ streak: 9, day: 2, gold: 30 });
  });

  it('starts again at day 1 after a missed day, keeping the best run', () => {
    let c = collect(null, '2026-11-01');
    c = collect(c, '2026-11-02');
    c = collect(c, '2026-11-03');
    expect(due(c, '2026-11-05')).toEqual({ streak: 1, day: 1, gold: 20 });
    c = collect(c, '2026-11-05');
    expect(c).toEqual({ last: '2026-11-05', streak: 1, best: 3 });
  });

  it('pays nothing when the clock is moved back before the last check-in', () => {
    const c = collect(null, '2026-11-10');
    expect(due(c, '2026-11-09')).toBeNull();
  });

  it('uses the local date', () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});
