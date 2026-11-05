// The daily puzzle's day (#99): today's band, the streak and the gold, without the pool (the home screen's
// Puzzle row needs these at startup; the pool and the screen load only when it's opened). The streak counts
// days a puzzle was played, one try per puzzle, right or wrong; it's its own, apart from the check-in.
import { BAND_OF_WEEKDAY, type Band } from '../engine/puzzles';
import { dayKey, daysBetween } from './checkin';
import type { PuzzleLog, PuzzlePick } from './store';

/** Gold for a puzzle (the day's and the Expert one alike): the best move, or any other try. */
export const PUZZLE_GOLD = { best: 20, tried: 5 } as const;

export type Which = 'daily' | 'expert';

/** The day's band, from its weekday (puzzles.ts picks the puzzle the same way). */
export function bandOf(day: string): Band {
  const [y, m, d] = day.split('-').map(Number);
  return BAND_OF_WEEKDAY[new Date(y!, m! - 1, d!).getDay()]!;
}

/** The weekday's name of a day ('YYYY-MM-DD'). */
export function weekdayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(y!, m! - 1, d!).getDay()]!;
}

/** The streak as it stands today: it holds through today if a puzzle was played today or yesterday. */
export function streakNow(l: PuzzleLog | null, today: string): number {
  if (!l) return 0;
  const gap = daysBetween(l.last, today);
  return gap === 0 || gap === 1 ? l.streak : 0;
}

/** Today's picks: what was played today, nothing if the log is from another day. */
export function picksOf(l: PuzzleLog | null, today: string): Partial<Record<Which, PuzzlePick>> {
  return l && l.last === today ? { daily: l.daily, expert: l.expert } : {};
}

/** The log after playing `which` today; unchanged if it was already played (one try per puzzle). */
export function played(l: PuzzleLog | null, today: string, which: Which, pick: PuzzlePick): PuzzleLog {
  if (picksOf(l, today)[which]) return l!;
  const gap = l ? daysBetween(l.last, today) : 0;
  // A clock moved back (gap < 0) keeps the streak as it is rather than resetting a real run.
  const streak = l && gap <= 0 ? l.streak : l && gap === 1 ? l.streak + 1 : 1;
  const base = l && gap === 0 ? l : { last: today, streak, best: l?.best ?? 0 };
  return { ...base, last: today, streak, best: Math.max(base.best, streak), [which]: pick };
}

/** The gold a pick earns. */
export const goldOf = (best: boolean) => (best ? PUZZLE_GOLD.best : PUZZLE_GOLD.tried);

/** The home screen's Puzzle row: today's band, whether today's puzzle is done, and the streak. */
export interface PuzzleBadge {
  band: Band;
  done: boolean;
  streak: number;
}
export const puzzleBadge = (l: PuzzleLog | null, today = dayKey()): PuzzleBadge => ({ band: bandOf(today), done: !!picksOf(l, today).daily, streak: streakNow(l, today) });
