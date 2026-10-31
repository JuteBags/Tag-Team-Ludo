// Gold (#35 phase 2): earned by playing, spent in the Store. Pure, so the amounts are tested.
// vs Computer pays for playing, your place, your kills and your tokens home; With friends pays a flat
// amount (the device belongs to one of the players, so nobody farms gold off friends).
import type { BotLevel } from '../engine';
import type { Stats } from './store';

/** Gold for each finishing place (index = place). */
const PLACE_GOLD = [0, 60, 30, 15, 0];

export interface GoldLine {
  label: string;
  gold: number;
}

/** Harder bots pay more: a bonus on top of everything vs Computer earned (Hard +50%, Extreme +150%). */
const LEVEL_BONUS: Partial<Record<BotLevel, { label: string; share: number }>> = {
  hard: { label: 'Hard bots bonus', share: 0.5 },
  extreme: { label: 'Extreme bots bonus', share: 1.5 },
};

/** What a finished game earns, line by line. `home` is how many of your tokens got home. */
export function goldFor(g: { mode: 'pvc' | 'pvp'; place: number; kills: number; home: number; level?: BotLevel }): GoldLine[] {
  if (g.mode === 'pvp') return [{ label: 'Game with friends', gold: 15 }];
  const lines: GoldLine[] = [{ label: 'Game played', gold: 20 }];
  const placeGold = PLACE_GOLD[g.place] ?? 0;
  if (placeGold) lines.push({ label: g.place === 1 ? 'Win' : `${['', '1st', '2nd', '3rd', '4th'][g.place]} place`, gold: placeGold });
  if (g.kills) lines.push({ label: `${g.kills} kill${g.kills === 1 ? '' : 's'}`, gold: 5 * g.kills });
  if (g.home) lines.push({ label: `${g.home} token${g.home === 1 ? '' : 's'} home`, gold: 5 * g.home });
  const bonus = g.level && LEVEL_BONUS[g.level];
  if (bonus) lines.push({ label: bonus.label, gold: Math.round(bonus.share * total(lines)) });
  return lines;
}

export const total = (lines: GoldLine[]) => lines.reduce((a, l) => a + l.gold, 0);

// ---------- achievements ----------

/** What one finished game tells the achievements, beyond the totals in Stats. */
export interface GameFacts {
  mode: 'pvc' | 'pvp';
  place: number;
  /** Your tokens that were captured this game. */
  lost: number;
  /** Every bot played at Hard. */
  hard: boolean;
}

export interface Achievement {
  id: string;
  name: string;
  blurb: string;
  gold: number;
  /** Done after this game, given the totals including it. */
  done: (s: Stats, g: GameFacts) => boolean;
  /** How far along you are, for the list ([have, need]); one-off achievements have none. */
  progress?: (s: Stats) => [number, number];
}

const count = (key: keyof Stats, need: number) => (s: Stats) => [Math.min(s[key], need), need] as [number, number];

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first-win', name: 'First win', blurb: 'Win a game vs Computer', gold: 100, done: (s) => s.wins >= 1, progress: count('wins', 1) },
  { id: 'wins-10', name: 'Champion', blurb: 'Win 10 games', gold: 300, done: (s) => s.wins >= 10, progress: count('wins', 10) },
  { id: 'streak-3', name: 'On a roll', blurb: 'Win 3 games in a row', gold: 200, done: (s) => s.bestStreak >= 3, progress: count('bestStreak', 3) },
  { id: 'kills-50', name: 'Hunter', blurb: 'Make 50 kills', gold: 200, done: (s) => s.kills >= 50, progress: count('kills', 50) },
  { id: 'sixes-100', name: 'Lucky hands', blurb: 'Roll 100 sixes', gold: 150, done: (s) => s.sixes >= 100, progress: count('sixes', 100) },
  { id: 'flawless', name: 'Untouchable', blurb: 'Win without losing a single token', gold: 250, done: (_, g) => g.mode === 'pvc' && g.place === 1 && g.lost === 0 },
  { id: 'hard-win', name: 'Giant slayer', blurb: 'Win against Hard or Extreme bots', gold: 300, done: (_, g) => g.mode === 'pvc' && g.place === 1 && g.hard },
  { id: 'friends-5', name: 'Party starter', blurb: 'Play 5 games with friends', gold: 100, done: (s) => s.friends >= 5, progress: count('friends', 5) },
];

/** The achievements this game completes that weren't already done. */
export const newAchievements = (s: Stats, g: GameFacts, achieved: string[]) => ACHIEVEMENTS.filter((a) => !achieved.includes(a.id) && a.done(s, g));
