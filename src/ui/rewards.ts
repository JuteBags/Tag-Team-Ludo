// Gold (#35 phase 2): earned by playing, spent in the Store. Pure, so the amounts are tested.
// vs Computer pays for playing, your place, your kills and your tokens home; With friends pays a flat
// amount (the device belongs to one of the players, so nobody farms gold off friends).
import type { BotLevel } from '../engine';
import { saveSetting, settings } from './settings';
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

/** The extra gold a level pays, as a share of the game's gold (0 for Easy and Normal). */
export const levelBonus = (level: BotLevel) => LEVEL_BONUS[level]?.share ?? 0;

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
  /** The game's bot level (its lowest bot's, `levelOf`), and its layout (`layoutOf`). */
  level?: BotLevel;
  layout?: string;
  /** Doubles were off. */
  singles?: boolean;
}

export type AchievementGroup = 'Ladder' | 'Extreme' | 'Milestones' | 'Everyday';

export interface Achievement {
  id: string;
  group: AchievementGroup;
  name: string;
  blurb: string;
  gold: number;
  /** Done, given the totals including this game (or check-in). `g` is null outside a game. */
  done: (s: Stats, g: GameFacts | null) => boolean;
  /** How far along you are, for the list ([have, need]); one-off achievements have none. */
  progress?: (s: Stats) => [number, number];
  /** Hide the progress bar while it reads 0 (a streak nobody has started). */
  quiet?: boolean;
}

type Count = { [K in keyof Stats]: Stats[K] extends number ? K : never }[keyof Stats];
const count = (key: Count, need: number) => (s: Stats) => [Math.min(s[key], need), need] as [number, number];
const atLeast = (key: Count, need: number) => (s: Stats) => s[key] >= need;
const won = (g: GameFacts | null, level?: BotLevel) => !!g && g.mode === 'pvc' && g.place === 1 && (!level || g.level === level);
const LAYOUTS = ['2p', '3p', '4p', '2h-opposite', '2h-side'];
const LEVELS: BotLevel[] = ['easy', 'normal', 'hard', 'extreme'];
/** Won at least once at `level` or above. */
const beaten = (level: BotLevel) => (s: Stats) => LEVELS.slice(LEVELS.indexOf(level)).some((l) => s.levelWins[l] > 0);

export const ACHIEVEMENTS: Achievement[] = [
  // The ladder: a win at one level counts for every level below it too.
  { id: 'win-easy', group: 'Ladder', name: 'First steps', blurb: 'Beat Easy bots', gold: 50, done: beaten('easy') },
  { id: 'win-normal', group: 'Ladder', name: 'Getting good', blurb: 'Beat Normal bots', gold: 100, done: beaten('normal') },
  { id: 'hard-win', group: 'Ladder', name: 'Giant slayer', blurb: 'Beat Hard or Extreme bots', gold: 300, done: beaten('hard') },
  { id: 'win-extreme', group: 'Ladder', name: 'Machine breaker', blurb: 'Beat Extreme bots', gold: 500, done: beaten('extreme') },
  // Extreme: one win can be luck, three in a row is not.
  { id: 'x-streak-3', group: 'Extreme', name: 'Hat-trick', blurb: 'Win 3 games in a row against Extreme, any mode', gold: 1500, done: atLeast('xBestStreak', 3), progress: count('xStreak', 3), quiet: true },
  { id: 'x-streak-5', group: 'Extreme', name: 'Unstoppable', blurb: 'Win 5 games in a row against Extreme, any mode', gold: 3000, done: atLeast('xBestStreak', 5), progress: count('xStreak', 5), quiet: true },
  { id: 'x-streak-7', group: 'Extreme', name: 'Grandmaster', blurb: 'Win 7 games in a row against Extreme, any mode', gold: 6000, done: atLeast('xBestStreak', 7), progress: count('xStreak', 7), quiet: true },
  { id: 'x-tour', group: 'Extreme', name: 'World tour', blurb: 'Beat Extreme in 2, 3 and 4 players, and with two houses each (opposite and side by side)', gold: 1000, done: (s) => LAYOUTS.every((l) => s.xModes.includes(l)), progress: (s) => [LAYOUTS.filter((l) => s.xModes.includes(l)).length, LAYOUTS.length] },
  { id: 'x-purist', group: 'Extreme', name: 'Purist', blurb: 'Beat Extreme with doubles off', gold: 300, done: (_, g) => won(g, 'extreme') && !!g!.singles },
  { id: 'x-odds', group: 'Extreme', name: 'Against all odds', blurb: 'Win a 4-player game against three Extreme bots', gold: 800, done: (_, g) => won(g, 'extreme') && g!.layout === '4p' },
  // Milestones.
  { id: 'first-win', group: 'Milestones', name: 'First win', blurb: 'Win a game vs Computer', gold: 100, done: atLeast('wins', 1), progress: count('wins', 1) },
  { id: 'wins-10', group: 'Milestones', name: 'Champion', blurb: 'Win 10 games', gold: 300, done: atLeast('wins', 10), progress: count('wins', 10) },
  { id: 'streak-3', group: 'Milestones', name: 'On a roll', blurb: 'Win 3 games in a row', gold: 200, done: atLeast('bestStreak', 3), progress: count('bestStreak', 3) },
  { id: 'kills-50', group: 'Milestones', name: 'Hunter', blurb: 'Make 50 kills', gold: 200, done: atLeast('kills', 50), progress: count('kills', 50) },
  { id: 'sixes-100', group: 'Milestones', name: 'Lucky hands', blurb: 'Roll 100 sixes', gold: 150, done: atLeast('sixes', 100), progress: count('sixes', 100) },
  { id: 'flawless', group: 'Milestones', name: 'Untouchable', blurb: 'Win without losing a single token', gold: 250, done: (_, g) => won(g) && g!.lost === 0 },
  { id: 'friends-5', group: 'Milestones', name: 'Party starter', blurb: 'Play 5 games with friends', gold: 100, done: atLeast('friends', 5), progress: count('friends', 5) },
  // Everyday: the daily check-in.
  { id: 'checkin-7', group: 'Everyday', name: 'Regular', blurb: 'Check in 7 days in a row', gold: 200, done: atLeast('checkinBest', 7), progress: count('checkinBest', 7) },
  { id: 'checkin-30', group: 'Everyday', name: 'Devoted', blurb: 'Check in 30 days in a row', gold: 1000, done: atLeast('checkinBest', 30), progress: count('checkinBest', 30) },
];

const NEW = 'ludo-ach-new';
/** Marks achievements done, and remembers them as new until the Stats sheet shows them. */
export function award(ids: string[]) {
  if (!ids.length) return;
  saveSetting('achieved', [...settings.achieved, ...ids.filter((id) => !settings.achieved.includes(id))]);
  try {
    localStorage.setItem(NEW, JSON.stringify([...new Set([...takeNew(), ...ids])]));
  } catch {
    // Not remembered as new: they still count, just without the highlight.
  }
}
/** The achievements earned since the Stats sheet last showed them, cleared on reading. */
export function takeNew(): string[] {
  try {
    const ids = JSON.parse(localStorage.getItem(NEW) ?? '[]') as string[];
    localStorage.removeItem(NEW);
    return ids;
  } catch {
    return [];
  }
}

/** The achievements these totals (and this game, if any) complete that weren't already done. */
export const newAchievements = (s: Stats, g: GameFacts | null, achieved: string[]) => ACHIEVEMENTS.filter((a) => !achieved.includes(a.id) && a.done(s, g));

/** The next Extreme streak achievement and how many more wins it needs, for the result screen; null with no live streak. */
export function nextStreak(s: Stats, achieved: string[]): { name: string; gold: number; more: number } | null {
  if (s.xStreak < 1) return null;
  const next = ACHIEVEMENTS.filter((a) => a.id.startsWith('x-streak-') && !achieved.includes(a.id)).find((a) => a.progress!(s)[1] > s.xStreak);
  return next ? { name: next.name, gold: next.gold, more: next.progress!(s)[1] - s.xStreak } : null;
}
