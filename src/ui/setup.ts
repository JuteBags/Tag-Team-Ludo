// Game setup logic, pure and tested: rolling for order and the house-picking rules. See setupScreen.ts.
import { COLORS, SEATS, type Color, type Seat } from '../engine';

/** vs Computer (you and bots) or With friends (pass-and-play, every seat a person). Both offline. */
export type Mode = 'pvc' | 'pvp';

/** Everything a game needs from the setup screen. */
export interface GameConfig {
  mode: Mode;
  /** One seat per colour in play; colours with the same owner are one person's houses. */
  seats: Seat[];
  /** The colour that plays first. */
  first: Color;
  /** Name of each person, by owner index. */
  names: string[];
  /** Doubles are off for this game (the Settings choice when it was set up). */
  singles?: boolean;
}

export type Pairing = 'opposite' | 'adjacent';
export interface PickRules {
  /** Houses per person: 2 only in 2-player games. */
  houses: 1 | 2;
  /** With two houses each: a person's two houses are opposite each other, or neighbours. */
  pairing: Pairing;
}
/** Who owns each house picked so far. */
export type Picks = Partial<Record<Color, number>>;

/** People grouped by roll, highest first; a group of more than one is a tie that rolls again. */
export function rankRolls(rolls: [person: number, roll: number][]): number[][] {
  const values = [...new Set(rolls.map(([, r]) => r))].sort((a, b) => b - a);
  return values.map((v) => rolls.filter(([, r]) => r === v).map(([p]) => p));
}

/** Who picks next, in roll order; with two houses each it goes round twice. */
export function pickSequence(order: number[], houses: 1 | 2): number[] {
  return houses === 2 ? [...order, ...order] : [...order];
}

const at = (i: number) => COLORS[(i + 4) % 4]!;
/** Houses that can pair with `c`. */
function partners(c: Color, pairing: Pairing): Color[] {
  const i = COLORS.indexOf(c);
  return pairing === 'opposite' ? [at(i + 2)] : [at(i + 1), at(i + 3)];
}

/**
 * Houses `person` may pick now. With two houses each, a second pick must pair with the first, and no
 * pick may leave anyone (with one house so far) without a free house to pair with.
 */
export function pickable(picks: Picks, person: number, rules: PickRules): Color[] {
  const free = COLORS.filter((c) => picks[c] === undefined);
  if (rules.houses === 1) return free;
  const mine = COLORS.filter((c) => picks[c] === person);
  const options = mine.length === 1 ? free.filter((c) => partners(mine[0]!, rules.pairing).includes(c)) : free;
  return options.filter((c) => feasible({ ...picks, [c]: person }, rules.pairing));
}

/** Every person holding one house still has a free house to pair it with. */
function feasible(picks: Picks, pairing: Pairing): boolean {
  const owners = [...new Set(Object.values(picks))];
  const free = COLORS.filter((c) => picks[c] === undefined);
  const needing = owners.filter((o) => COLORS.filter((c) => picks[c] === o).length === 1);
  // Each person still needing a partner must be able to get a different free house.
  const go = (i: number, used: Set<Color>): boolean => {
    if (i === needing.length) return true;
    const own = COLORS.find((c) => picks[c] === needing[i])!;
    return partners(own, pairing).some((c) => free.includes(c) && !used.has(c) && go(i + 1, new Set([...used, c])));
  };
  return go(0, new Set());
}

/** What the setup preview shows on a house: a person (by number), a bot, or nobody. */
export type Slot = 'p1' | 'p2' | 'p3' | 'p4' | 'bot' | 'empty';

/**
 * Who plays each house, for the preview before houses are picked: the layout, not the final houses.
 * People take the usual seats (with two colours each, person 1 has Blue and the house opposite or beside
 * it), bots fill the next free houses in turn order, and the rest stay empty.
 */
export function previewLayout(count: 2 | 3 | 4, rules: PickRules, bots: number): Record<Color, Slot> {
  const layout = Object.fromEntries(COLORS.map((c) => [c, 'empty'])) as Record<Color, Slot>;
  if (rules.houses === 2) {
    const mate: Color = rules.pairing === 'opposite' ? 'red' : 'yellow';
    for (const c of COLORS) layout[c] = c === 'blue' || c === mate ? 'p1' : 'p2';
    return layout;
  }
  SEATS[count].forEach((c, i) => (layout[c] = `p${i + 1}` as Slot));
  for (const c of COLORS.filter((x) => layout[x] === 'empty').slice(0, bots)) layout[c] = 'bot';
  return layout;
}

/** Longest name a person can give themselves. */
export const NAME_MAX = 12;

/**
 * A name typed by a person, made safe to show: no characters that could form markup, single spaces, at
 * most NAME_MAX characters. An empty result falls back to `fallback` ("Player 2", "You").
 */
export function cleanName(raw: string, fallback: string): string {
  const name = raw.replace(/[<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  return name || fallback;
}

/** The name a seat starts with: what was typed there last time, or the default. */
export const defaultName = (mode: Mode, seat: number) => (mode === 'pvp' ? `Player ${seat + 1}` : 'You');
