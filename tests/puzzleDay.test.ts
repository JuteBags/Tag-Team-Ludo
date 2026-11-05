// The daily puzzle's day (src/ui/puzzleDay.ts): the band by weekday, the streak of days played, one try each.
import { describe, expect, it } from 'vitest';
import { bandOf, goldOf, picksOf, played, streakNow, weekdayOf, winMove } from '../src/ui/puzzleDay';

const right = { pick: 0, best: true };
const wrong = { pick: 2, best: false };

describe('daily puzzle day', () => {
  it('takes the band from the weekday: Mon-Wed Easy, Thu-Fri Medium, Sat-Sun Hard', () => {
    // 2026-11-02 is a Monday.
    const week = ['02', '03', '04', '05', '06', '07', '08'].map((d) => bandOf(`2026-11-${d}`));
    expect(week).toEqual(['easy', 'easy', 'easy', 'medium', 'medium', 'hard', 'hard']);
    expect(weekdayOf('2026-11-05')).toBe('Thursday');
  });

  it('starts a streak on the first puzzle, right or wrong', () => {
    const l = played(null, '2026-11-05', 'daily', wrong);
    expect(l).toEqual({ last: '2026-11-05', streak: 1, best: 1, daily: wrong });
    expect(streakNow(l, '2026-11-05')).toBe(1);
  });

  it('allows one try per puzzle: a second pick of the same puzzle changes nothing', () => {
    const l = played(null, '2026-11-05', 'daily', wrong);
    expect(played(l, '2026-11-05', 'daily', right)).toBe(l);
  });

  it('counts the day once when both puzzles are played', () => {
    let l = played(null, '2026-11-05', 'daily', right);
    l = played(l, '2026-11-05', 'expert', wrong);
    expect(l.streak).toBe(1);
    expect(picksOf(l, '2026-11-05')).toEqual({ daily: right, expert: wrong });
  });

  it('grows on the next day, across a month end, and the picks start fresh', () => {
    let l = played(null, '2026-11-29', 'daily', right);
    l = played(l, '2026-11-30', 'expert', right);
    l = played(l, '2026-12-01', 'daily', wrong);
    expect(l).toEqual({ last: '2026-12-01', streak: 3, best: 3, daily: wrong });
    expect(picksOf(l, '2026-12-02')).toEqual({});
  });

  it('holds through a day not yet played, and resets after a missed day, keeping the best', () => {
    let l = played(null, '2026-11-01', 'daily', right);
    l = played(l, '2026-11-02', 'daily', right);
    expect(streakNow(l, '2026-11-03')).toBe(2);
    expect(streakNow(l, '2026-11-04')).toBe(0);
    l = played(l, '2026-11-04', 'daily', right);
    expect(l.streak).toBe(1);
    expect(l.best).toBe(2);
  });

  it('keeps the streak when the clock is moved back', () => {
    let l = played(null, '2026-11-04', 'daily', right);
    l = played(l, '2026-11-05', 'daily', right);
    expect(played(l, '2026-11-03', 'daily', right).streak).toBe(2);
  });

  it('pays 20 for the best move and 5 for a try', () => {
    expect([goldOf(true), goldOf(false)]).toEqual([20, 5]);
  });
  it('says what happens to your win %, never a bare minus (#194)', () => {
    expect(winMove(5.4)).toBe('Win % ▲ 5');
    expect(winMove(-2.6)).toBe('Win % ▼ 3');
    expect(winMove(0.4)).toBe('Win % about the same');
    expect(winMove(-0.4)).toBe('Win % about the same');
  });
});
