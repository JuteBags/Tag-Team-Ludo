// Ranked PvP: ratings, tiers and the matchmaking window. Pure, shared by the server (which rates games and
// matches people) and the app (which shows tiers), and tested in tests/rating.test.ts.
//
// A rating is Elo-style, one per mode, starting at START_RATING. People see a tier and points, not the number:
//   Bronze < 1000 <= Silver < 1300 <= Gold < 1600 <= Platinum < 1900 <= Diamond
// Each tier below Diamond has three divisions of 100 (III, II, I); points are the rating within its division
// (0-99). Diamond has no divisions: its points count up from 1900.
import type { BotLevel } from '../engine';

export const START_RATING = 1000;
/** K while a person has played fewer than PROVISIONAL games in a mode, then after. */
export const K_NEW = 40;
export const K = 24;
export const PROVISIONAL = 10;

export interface Tier {
  tier: 'Bronze' | 'Silver' | 'Gold' | 'Platinum' | 'Diamond';
  /** 'III', 'II', 'I', or '' for Diamond. */
  division: string;
  points: number;
  /** "Gold II", "Diamond". */
  label: string;
}

const TIERS: [Tier['tier'], number][] = [
  ['Diamond', 1900],
  ['Platinum', 1600],
  ['Gold', 1300],
  ['Silver', 1000],
  ['Bronze', 700],
];
const DIVS = ['III', 'II', 'I'];

export function tierOf(rating: number): Tier {
  const r = Math.round(rating);
  for (const [tier, from] of TIERS) {
    if (r < from && tier !== 'Bronze') continue;
    if (tier === 'Diamond') return { tier, division: '', points: r - from, label: 'Diamond' };
    // Bronze has no floor: anything under 700 is Bronze III with 0 points.
    const into = Math.max(0, r - from);
    const d = Math.min(2, Math.floor(into / 100));
    return { tier, division: DIVS[d]!, points: r < from ? 0 : into - 100 * d, label: `${tier} ${DIVS[d]}` };
  }
  throw new Error('unreachable');
}

/** The chance that a rating `a` beats `b` (Elo). */
export const expected = (a: number, b: number) => 1 / (1 + Math.pow(10, (b - a) / 400));

/** One side of a finished ranked game: its members' ratings and games played, and its place (0 = first). */
export interface RatedSide {
  /** Ratings of everyone on the side, bots included (a bot is rated at the rating it was given). */
  ratings: number[];
  /** Games each member had played in this mode before (bots: PROVISIONAL, so they count fully). */
  games: number[];
  place: number;
}

/**
 * Each side member's rating change. A side's strength is its members' average. Two sides: win or lose against
 * the other. More sides (1v1v1v1): every pair of sides is one game, won by the better place, and the sum is
 * shared over the n-1 pairs. Each member's K follows their own games played.
 */
export function rate(sides: RatedSide[]): number[][] {
  const avg = sides.map((s) => s.ratings.reduce((a, b) => a + b, 0) / s.ratings.length);
  const n = sides.length;
  return sides.map((side, i) => {
    let score = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const s = side.place < sides[j]!.place ? 1 : side.place > sides[j]!.place ? 0 : 0.5;
      score += s - expected(avg[i]!, avg[j]!);
    }
    const share = score / (n - 1);
    return side.games.map((g) => Math.round((g < PROVISIONAL ? K_NEW : K) * share));
  });
}

/** How far apart two people's ratings may be to be matched, after waiting `ms`: 100, growing 10 a second. */
export const matchWindow = (ms: number) => 100 + Math.floor(ms / 1000) * 10;

// ---------- who can be matched (#216, the owner's rules) ----------
// The search stays in your league (Bronze, Silver, Gold, Platinum, Diamond), the window widening as you wait;
// after LOWER_LEAGUE_MS it may also take people from the league just below yours, never further, never above.
// Up to Gold III (a rating under BOTS_BELOW), if no one is found in BOT_FILL_MS, bots of your strength fill the
// empty places: they look like any player and the game counts fully. From Gold II up, people only.

/** The league a rating is in: 0 Bronze, 1 Silver, 2 Gold, 3 Platinum, 4 Diamond. */
export const leagueOf = (rating: number) => (rating < 1000 ? 0 : rating < 1300 ? 1 : rating < 1600 ? 2 : rating < 1900 ? 3 : 4);
/** After this long, the search may also take people from the league just below. */
export const LOWER_LEAGUE_MS = 20_000;
/** After this long, bots fill the empty places, if everyone in the group is under BOTS_BELOW. */
export const BOT_FILL_MS = 45_000;
/** Bots only for ratings under this: Gold III (1300-1399) and below. */
export const BOTS_BELOW = 1400;
/** A hint after this long: playing with friends in a private room instead. */
export const SEARCH_HINT_MS = 30_000;

/** Someone in the queue: their rating and since when they've searched. */
export interface Searcher {
  rating: number;
  since: number;
}
/**
 * Whether `a` and `b` may play each other now: the same league, within the wider of their two windows; or
 * neighbouring leagues, once the one in the higher league has searched LOWER_LEAGUE_MS (they widen downwards).
 */
export function canMatch(a: Searcher, b: Searcher, now: number): boolean {
  const gap = Math.abs(a.rating - b.rating);
  if (gap > Math.max(matchWindow(now - a.since), matchWindow(now - b.since))) return false;
  const la = leagueOf(a.rating);
  const lb = leagueOf(b.rating);
  if (la === lb) return true;
  if (Math.abs(la - lb) !== 1) return false;
  return now - (la > lb ? a : b).since >= LOWER_LEAGUE_MS;
}
/** Whether bots may fill a group's empty places: everyone is under BOTS_BELOW (Gold III and below). */
export const botsAllowed = (group: { rating: number }[]) => group.every((w) => w.rating < BOTS_BELOW);

/** The level a ranked bot plays at for a rating. */
export const botLevelFor = (rating: number): Exclude<BotLevel, 'extreme'> => (rating < 1000 ? 'easy' : rating < 1300 ? 'normal' : 'hard');
