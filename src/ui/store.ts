// Device storage for the saved game and the stats. Capacitor Preferences keeps them in Android's
// SharedPreferences (which survive low storage better than localStorage) and in localStorage on the
// web. Every call is guarded: if storage fails, the game simply isn't saved.
import { Preferences } from '@capacitor/preferences';
import type { Color, GameState } from '../engine';
import type { GameConfig } from './setup';

async function read<T>(key: string): Promise<T | null> {
  try {
    const { value } = await Preferences.get({ key });
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
}

async function write(key: string, v: unknown) {
  try {
    await Preferences.set({ key, value: JSON.stringify(v) });
  } catch {
    // Not saved this time.
  }
}

async function drop(key: string) {
  try {
    await Preferences.remove({ key });
  } catch {
    // Nothing to remove.
  }
}

// ---------- the unfinished game ----------

/** Everything needed to pick a game up again, saved at the start of every turn. */
export interface SavedGame {
  v: 1;
  config: GameConfig;
  state: GameState;
  /** This game's running stats for the person playing vs Computer. */
  kills: number;
  pairs: number;
  /** Last face each colour rolled, so the resting dice look the same. */
  faces: [Color, number][];
  savedAt: number;
}

const GAME = 'ludo-save';
export const loadGame = () =>
  read<SavedGame>(GAME).then((g) => {
    if (g?.v !== 1 || g.state?.phase === 'over') return null;
    // Saves from before the tray (1.5) are always at the start of a turn: an empty tray.
    g.state.rolls ??= [];
    return g;
  });
export const saveGame = (g: SavedGame) => write(GAME, g);
export const clearGame = () => drop(GAME);

// ---------- stats ----------

/** Totals on this device. Kills, pairs and places count the person playing vs Computer. */
export interface Stats {
  played: number;
  wins: number;
  /** Best finishing place so far (1 = won), 0 before the first game. */
  best: number;
  kills: number;
  pairs: number;
  /** Games played in "With friends". */
  friends: number;
  /** Sixes you rolled, and wins in a row (now and best). */
  sixes: number;
  streak: number;
  bestStreak: number;
}

const STATS = 'ludo-stats';
export const EMPTY_STATS: Stats = { played: 0, wins: 0, best: 0, kills: 0, pairs: 0, friends: 0, sixes: 0, streak: 0, bestStreak: 0 };
export const loadStats = () => read<Partial<Stats>>(STATS).then((s) => ({ ...EMPTY_STATS, ...s }));
export const resetStats = () => drop(STATS);

/** Adds one finished game to the totals and returns the new totals. */
export async function recordGame(g: { mode: 'pvc' | 'pvp'; place: number; kills: number; pairs: number; sixes?: number }): Promise<Stats> {
  const s = await loadStats();
  if (g.mode === 'pvp') s.friends++;
  else {
    s.played++;
    if (g.place === 1) s.wins++;
    s.best = s.best ? Math.min(s.best, g.place) : g.place;
    s.kills += g.kills;
    s.pairs += g.pairs;
    s.sixes += g.sixes ?? 0;
    s.streak = g.place === 1 ? s.streak + 1 : 0;
    s.bestStreak = Math.max(s.bestStreak, s.streak);
  }
  await write(STATS, s);
  return s;
}

// ---------- daily check-in (checkin.ts) ----------

/** The last day collected (local YYYY-MM-DD), the days in a row up to it, and the longest run so far. */
export interface CheckIn {
  last: string;
  streak: number;
  best: number;
}

const CHECKIN = 'ludo-checkin';
/** The stored check-in, null before the first one, or 'error' when storage can't be read (then no offer). */
export async function loadCheckIn(): Promise<CheckIn | null | 'error'> {
  try {
    const { value } = await Preferences.get({ key: CHECKIN });
    return value ? (JSON.parse(value) as CheckIn) : null;
  } catch {
    return 'error';
  }
}
/** Stores the check-in; false when the write failed (then the gold isn't paid, so it can't be paid twice). */
export async function saveCheckIn(c: CheckIn): Promise<boolean> {
  try {
    await Preferences.set({ key: CHECKIN, value: JSON.stringify(c) });
    return true;
  } catch {
    return false;
  }
}
