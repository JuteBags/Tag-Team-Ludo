// The daily puzzle (#99): a position with one clear best move, from the curated pool (tools/ai/puzzles.ts,
// checked at 1,024 playouts per candidate, merged by tools/ai/puzzles_merge.ts into puzzle-pool.json).
// Everyone gets the same puzzle on the same calendar day, with no server: the day picks a band by its
// weekday (Mon–Wed Easy, Thu–Fri Medium, Sat–Sun Hard), and the band's list by how many days of that band
// have passed since EPOCH. The pool loads on its own (a lazy chunk), only when a puzzle is opened.
// puzzle-pool.json (v2): puzzles.yml run 41893707591 (games 1-240, 4 shards x 60) and run 41901810812 (a
// Hard top-up: games 241-300, --only normal-4p, 4 x 15), merged by tools/ai/puzzles_merge.ts over all 8
// shards: 367 puzzles (157 Easy, 105 Medium, 105 Hard: any 365 days in a row), 16.0 kB gzip. v2 prefers
// positions with 3+ candidates: every Easy and Medium one; Hard 70, and 35 with 2 (Hard is always a move the
// Normal bot gets wrong, with the other move within 15·f: a trap, not a coin flip).
// v3 adds the Expert list (the owner's extra daily puzzle): 71 positions even the Hard bot gets wrong, none
// of them a daily puzzle, the daily bands kept exactly as in v2; with run 41912353721 (an Expert top-up: games
// 301-420, 4p with a Normal player, 8 x 15): 19.0 kB gzip in all. expertFrom is set by the 3.5.0 release.
// Pool.v changes with every regeneration or re-merge: a cached entry is decoded only against its own version.
import { FINISHED, SEATS, type Color } from './board';
import { createGame, move, roll, trayMoves } from './game';
import { moveEvent } from './record';
import type { GameState } from './types';

export type Band = 'easy' | 'medium' | 'hard';

/** One puzzle as stored (puzzles_merge.ts compact): see decodePuzzle. */
export type PoolEntry = [string, number[], number, number[], number[], number[], number, number, number, string, number, string, number];
export interface Pool {
  /** Bumped by every regeneration or re-merge (a cache of an entry keys on it). */
  v: number;
  easy: PoolEntry[];
  medium: PoolEntry[];
  hard: PoolEntry[];
  /** The Expert puzzles (v3, #99): one a day from expertFrom ('YYYY-MM-DD'), never a daily puzzle. */
  expertFrom?: string;
  expert?: PoolEntry[];
}

/** expertFrom until the release sets it: no Expert puzzle shows before that day (tests fail on it at 3.5.0). */
export const EXPERT_FROM_UNSET = '2099-01-01';

export interface Puzzle {
  band: Band;
  layout: '2p' | '4p';
  /** The position: the mover to choose among state.moves (from the tray). */
  state: GameState;
  /** Per move in state.moves: points of win chance below the best (0 for the best), and the mover's win %. */
  gaps: number[];
  chances: number[];
  best: number;
  /** The Hard bot misses it too (for a rare "Expert" tag later; not a band). */
  expert: boolean;
  /** The reveal's example line from the best move (events, as a game record's), with the seed it was played from. */
  line: { seed: number; events: string };
  /** The most tempting wrong move (the Normal bot's pick, else the 2nd best) and its line, same seed. */
  wrong: { move: number; events: string };
}

/** Day 0 of the puzzle calendar. */
export const EPOCH = { y: 2026, m: 1, d: 1 };
/** The band of each weekday, Sunday first (Date.getDay). */
export const BAND_OF_WEEKDAY: readonly Band[] = ['hard', 'easy', 'easy', 'easy', 'medium', 'medium', 'hard'];

const DAY = 86_400_000;
const utcDay = (y: number, m: number, d: number) => Math.round(Date.UTC(y, m - 1, d) / DAY);

/** Days since EPOCH for a local calendar day as check-in writes it ('YYYY-MM-DD', checkin.ts dayKey). */
export function dayNumber(dayKey: string): number {
  const [y, m, d] = dayKey.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`not a day: ${dayKey}`);
  return utcDay(y, m, d) - utcDay(EPOCH.y, EPOCH.m, EPOCH.d);
}

/** The weekday (0 Sunday) of a day number. */
const weekday = (n: number) => new Date((n + utcDay(EPOCH.y, EPOCH.m, EPOCH.d)) * DAY).getUTCDay();

/** The day's band, and which of the band's puzzles: how many days of that band came before it, cycled. */
export function puzzleOf(dayKey: string, pool: Pool): { band: Band; index: number } {
  const n = dayNumber(dayKey);
  const band = BAND_OF_WEEKDAY[weekday(n)]!;
  const perWeek = BAND_OF_WEEKDAY.filter((b) => b === band).length;
  const weeks = Math.floor(n / 7);
  let before = weeks * perWeek;
  for (let k = weeks * 7; k < n; k++) if (BAND_OF_WEEKDAY[weekday(k)] === band) before++;
  const len = pool[band].length;
  return { band, index: ((before % len) + len) % len };
}

/** A stored puzzle as a position to play: the seats of its layout, its tokens, mover and tray. */
export function decodePuzzle(e: PoolEntry, band: Band): Puzzle {
  const [layout, tokens, mover, tray, gaps, chances, best, expert, seed, events, wrong, wrongEvents, singles] = e;
  if (layout !== '2p' && layout !== '4p') throw new Error(`puzzle layout ${layout}`);
  const colors = SEATS[layout === '2p' ? 2 : 4];
  const g = createGame(
    colors.map((color, owner) => ({ color, owner, bot: owner !== mover })),
    colors[mover] as Color,
    singles === 1,
  );
  const players = g.players.map((p) => ({ ...p, tokens: tokens.slice(4 * colors.indexOf(p.color), 4 * colors.indexOf(p.color) + 4) }));
  // Who has finished decides whose turn comes next; the order among them doesn't matter before the end.
  const ranking = players.filter((p) => p.tokens.every((t) => t === FINISHED)).map((p) => p.color);
  const current = players.findIndex((p) => p.color === colors[mover]);
  const state: GameState = { ...g, players, ranking, current, phase: 'move', dice: tray.at(-1) ?? null, rolls: [...tray], sixes: 0, moves: trayMoves(players, colors[mover]!, tray, singles === 1), event: null };
  return { band, layout, state, gaps, chances, best, expert: expert === 1, line: { seed, events }, wrong: { move: wrong, events: wrongEvents } };
}

/** The day's puzzle from the pool (everyone's the same on the same calendar day). */
export function dailyPuzzle(dayKey: string, pool: Pool): Puzzle {
  const { band, index } = puzzleOf(dayKey, pool);
  return decodePuzzle(pool[band][index]!, band);
}

/**
 * The day's Expert puzzle (#99, the owner's): beside the daily one, a position even the Hard bot gets wrong,
 * one a day in the list's order from the pool's expertFrom. Null before that day, once the list is used up,
 * or with no list (an older pool). Never the day's daily puzzle: the lists share no position.
 */
export function dailyExpert(dayKey: string, pool: Pool): Puzzle | null {
  const list = pool.expert;
  if (!list?.length || !pool.expertFrom) return null;
  const i = dayNumber(dayKey) - dayNumber(pool.expertFrom);
  if (i < 0 || i >= list.length) return null;
  return decodePuzzle(list[i]!, 'hard');
}

/** The pool (a lazy chunk of its own: nothing at startup). */
export async function loadPool(): Promise<Pool> {
  return (await import('./puzzle-pool.json')).default as unknown as Pool;
}

/** A pick's verdict: the best move, the points the pick gives up, and both win chances. */
export function checkPick(p: Puzzle, pick: number): { isBest: boolean; best: number; lost: number; pickChance: number; bestChance: number } {
  return { isBest: p.gaps[pick] === 0, best: p.best, lost: p.gaps[pick]!, pickChance: p.chances[pick]!, bestChance: p.chances[p.best]! };
}

/**
 * The positions of a reveal line (the puzzle's, or with `wrong` the wrong move's): the position, then after
 * every event. It's an example (one way it could go, from its seed), not a forecast. Null if an event doesn't fit.
 */
export function lineStates(p: Puzzle, wrong = false): GameState[] | null {
  const e = wrong ? p.wrong.events : p.line.events;
  let s = p.state;
  const states = [s];
  for (let i = 0; i < e.length; i++) {
    if (s.phase === 'over') return null;
    if (s.phase === 'roll') {
      const face = Number(e[i]);
      if (!(face >= 1 && face <= 6)) return null;
      s = roll(s, () => 0, face);
    } else {
      const code = e.slice(i, i + 2);
      const m = s.moves.filter((x) => moveEvent(x) === code);
      if (m.length !== 1) return null;
      s = move(s, m[0]!);
      i++;
    }
    states.push(s);
  }
  return states;
}
