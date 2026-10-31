// Weighted dice: the only spec of how a roll is made. Keep this out of every .md file and the website.
//
// Rules (weights in eighteenths; everyone gets them, bots included):
//  1. Before each roll, every face starts at 3/18 (16.7%).
//  2. A face that would capture an enemy token ("kill"), a pair capturing a pair included, goes up to 4/18 (22.2%).
//  3. A face that would take a threatened token or pair to a star or into the home column ("escape")
//     goes up to 4/18. Threatened = some enemy could capture it with one roll of 1-6 (see isThreatened).
//  4. At most 2 faces are boosted per roll: kills first, then escapes; ties are picked at random.
//  5. A face that would finish a token exactly goes down to 2/18 (11.1%).
//  6. A face that is both boosted and lowered stays at 3/18.
//  7. Bringing a token out of base is not a reason to boost the 6.
//  8. The untouched faces share the difference equally, so the six faces always add up to 1.
//  9. No face goes below 2/18 or above 5/18.
//
// Known risks: bots get the kill boost too, so they hit the human a little more often. The repo is
// public, so anyone who reads this file can find the weighting; we never advertise "fair dice".
// `npm run sim` measures what the weighting does to kills, escapes and game length.
import type { Color } from './board';
import { isEscape, legalMoves } from './rules';
import type { PlayerState, Rng } from './types';

const BASE_W = 3;
const MIN_W = 2;
const MAX_W = 5;
const MAX_BOOSTED = 2;

export interface DiceAnalysis {
  kill: number[];
  escape: number[];
  finish: number[];
  boosted: number[];
}

function shuffle<T>(a: T[], rng: Rng): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Probability of each face 1-6 for `color`'s next roll, plus why. `singles`: doubles are off (rules.ts). */
export function analyzeDice(players: PlayerState[], color: Color, rng: Rng, singles = false): { weights: number[]; why: DiceAnalysis } {
  const kill: number[] = [];
  const escape: number[] = [];
  const finish: number[] = [];
  for (let f = 1; f <= 6; f++) {
    const moves = legalMoves(players, color, f, singles);
    if (moves.some((m) => m.captures.length > 0)) kill.push(f);
    if (moves.some((m) => isEscape(players, m, singles))) escape.push(f);
    if (moves.some((m) => m.finishes > 0)) finish.push(f);
  }
  const boosted = [...shuffle([...kill], rng), ...shuffle(escape.filter((f) => !kill.includes(f)), rng)].slice(0, MAX_BOOSTED);

  const w = [BASE_W, BASE_W, BASE_W, BASE_W, BASE_W, BASE_W];
  for (const f of boosted) w[f - 1]! += 1;
  for (const f of finish) w[f - 1]! -= 1;

  // Untouched faces absorb the difference so the total stays 18.
  const untouched = [0, 1, 2, 3, 4, 5].filter((i) => !boosted.includes(i + 1) && !finish.includes(i + 1));
  rebalance(w, untouched.length ? untouched : [0, 1, 2, 3, 4, 5]);
  for (let pass = 0; pass < 6; pass++) {
    for (let i = 0; i < 6; i++) w[i] = Math.min(MAX_W, Math.max(MIN_W, w[i]!));
    const diff = w.reduce((a, b) => a + b, 0) - 18;
    if (Math.abs(diff) < 1e-9) break;
    rebalance(w, [0, 1, 2, 3, 4, 5].filter((i) => (diff > 0 ? w[i]! > MIN_W : w[i]! < MAX_W)));
  }
  return { weights: w.map((x) => x / 18), why: { kill, escape, finish, boosted } };
}

function rebalance(w: number[], faces: number[]) {
  const diff = w.reduce((a, b) => a + b, 0) - 18;
  for (const i of faces) w[i]! -= diff / faces.length;
}

export const diceWeights = (players: PlayerState[], color: Color, rng: Rng, singles = false) => analyzeDice(players, color, rng, singles).weights;

/** Samples a face 1-6 from the weights. */
export function sampleFace(weights: number[], rng: Rng): number {
  let r = rng();
  for (let i = 0; i < 5; i++) {
    r -= weights[i]!;
    if (r < 0) return i + 1;
  }
  return 6;
}

export const rollDice = (players: PlayerState[], color: Color, rng: Rng, singles = false) => sampleFace(diceWeights(players, color, rng, singles), rng);
