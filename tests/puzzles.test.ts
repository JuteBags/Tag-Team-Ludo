// The daily puzzle (#99, src/engine/puzzles.ts): the calendar (the same puzzle for everyone on a day, the
// band by weekday, no repeat within a year), and every puzzle in the shipped pool: its position decodes to
// the moves it was reviewed with, one clear best, and both reveal lines replay from it.
import { describe, expect, it } from 'vitest';
// @ts-expect-error: the project has no @types/node; Vitest runs on Node.
import { readFileSync } from 'node:fs';
import { moveEvent } from '../src/engine';
import { BAND_OF_WEEKDAY, checkPick, dailyPuzzle, dayNumber, decodePuzzle, lineStates, puzzleOf, type Band, type Pool } from '../src/engine/puzzles';

const pool = JSON.parse(readFileSync(new URL('../src/engine/puzzle-pool.json', import.meta.url), 'utf8')) as Pool;
const BANDS: Band[] = ['easy', 'medium', 'hard'];
const key = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => key(new Date(Date.UTC(2026, 0, 1) + (dayNumber(from) + i) * 86_400_000)));

describe('the puzzle calendar', () => {
  it('counts days from 1 January 2026 by the calendar date (no clock, no daylight saving)', () => {
    expect(dayNumber('2026-01-01')).toBe(0);
    expect(dayNumber('2026-03-29')).toBe(87); // Europe's clocks go forward that night
    expect(dayNumber('2027-01-01')).toBe(365);
    expect(dayNumber('2025-12-31')).toBe(-1);
  });

  it('gives the band by weekday: Mon–Wed Easy, Thu–Fri Medium, Sat–Sun Hard', () => {
    expect(BAND_OF_WEEKDAY).toEqual(['hard', 'easy', 'easy', 'easy', 'medium', 'medium', 'hard']);
    expect(puzzleOf('2026-01-01', pool).band).toBe('medium'); // a Thursday
    expect(puzzleOf('2026-01-03', pool).band).toBe('hard'); // a Saturday
    expect(puzzleOf('2026-01-05', pool).band).toBe('easy'); // a Monday
  });

  it('is the same for everyone on a day, and repeats no puzzle within a year', () => {
    expect(puzzleOf('2026-11-05', pool)).toEqual(puzzleOf('2026-11-05', pool));
    // Starting on every weekday (2026-01-01 is a Thursday).
    for (const start of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '2027-06-15']) {
      const picks = days(start, 365).map((d) => puzzleOf(d, pool));
      expect(new Set(picks.map((p) => `${p.band} ${p.index}`)).size).toBe(365);
    }
  });

  it('works before the first day too', () => {
    const p = puzzleOf('2025-12-20', pool);
    expect(p.index).toBeGreaterThanOrEqual(0);
    expect(p.index).toBeLessThan(pool[p.band].length);
  });
});

describe('the pool', () => {
  it("has a year's worth per band", () => {
    expect(pool.v).toBe(2);
    expect(pool.easy.length).toBeGreaterThanOrEqual(157);
    // Any 365 days in a row: up to 157 Mon–Wed, 105 Thu–Fri and 105 Sat–Sun days.
    expect(pool.medium.length).toBeGreaterThanOrEqual(105);
    expect(pool.hard.length).toBeGreaterThanOrEqual(105);
  });

  for (const band of BANDS)
    it(`${band}: every puzzle decodes to its moves, has one clear best, and both lines replay`, () => {
      pool[band].forEach((e, i) => {
        const p = decodePuzzle(e, band);
        const at = `${band} ${i}`;
        expect(p.state.moves.length, at).toBe(p.gaps.length);
        expect(p.chances.length, at).toBe(p.gaps.length);
        expect(p.gaps[p.best], at).toBe(0);
        // Every move that isn't the best gives up points (moves reaching the best's position count as it).
        expect(p.gaps.some((g) => g > 0), at).toBe(true);
        expect(p.gaps[p.wrong.move]!, at).toBeGreaterThan(0);
        const best = lineStates(p);
        const wrong = lineStates(p, true);
        expect(best, at).not.toBe(null);
        expect(wrong, at).not.toBe(null);
        expect(p.line.events.slice(0, 2), at).toBe(moveEvent(p.state.moves[p.best]!));
        expect(p.wrong.events.slice(0, 2), at).toBe(moveEvent(p.state.moves[p.wrong.move]!));
      });
    });

  it("v2: every Easy and Medium puzzle has 3+ candidates; Hard ones with 2 are the Normal bot's traps", () => {
    const cands = (e: (typeof pool.easy)[number]) => new Set(e[4]).size;
    expect(pool.easy.every((e) => cands(e) >= 3)).toBe(true);
    expect(pool.medium.every((e) => cands(e) >= 3)).toBe(true);
    expect(pool.hard.filter((e) => cands(e) >= 3).length).toBeGreaterThanOrEqual(70);
  });

  it("judges a pick: the best, the points a pick gives up, and both win chances", () => {
    const p = dailyPuzzle('2026-11-05', pool);
    expect(checkPick(p, p.best)).toEqual({ isBest: true, best: p.best, lost: 0, pickChance: p.chances[p.best], bestChance: p.chances[p.best] });
    const w = checkPick(p, p.wrong.move);
    expect(w.isBest).toBe(false);
    expect(w.lost).toBe(p.gaps[p.wrong.move]);
  });
});
