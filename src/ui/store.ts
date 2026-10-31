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
export const loadGame = () => read<SavedGame>(GAME).then((g) => (g?.v === 1 && g.state?.phase !== 'over' ? g : null));
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
}

const STATS = 'ludo-stats';
export const EMPTY_STATS: Stats = { played: 0, wins: 0, best: 0, kills: 0, pairs: 0, friends: 0 };
export const loadStats = () => read<Partial<Stats>>(STATS).then((s) => ({ ...EMPTY_STATS, ...s }));
export const resetStats = () => drop(STATS);

/** Adds one finished game to the totals. */
export async function recordGame(g: { mode: 'pvc' | 'pvp'; place: number; kills: number; pairs: number }) {
  const s = await loadStats();
  if (g.mode === 'pvp') s.friends++;
  else {
    s.played++;
    if (g.place === 1) s.wins++;
    s.best = s.best ? Math.min(s.best, g.place) : g.place;
    s.kills += g.kills;
    s.pairs += g.pairs;
  }
  await write(STATS, s);
}
