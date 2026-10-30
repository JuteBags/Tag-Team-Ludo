// Weighted dice. Weights are in eighteenths; see "Weighted dice" in docs/RULES.md.
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

/** Probability of each face 1-6 for `color`'s next roll, plus why. */
export function analyzeDice(players: PlayerState[], color: Color, rng: Rng): { weights: number[]; why: DiceAnalysis } {
  const kill: number[] = [];
  const escape: number[] = [];
  const finish: number[] = [];
  for (let f = 1; f <= 6; f++) {
    const moves = legalMoves(players, color, f);
    if (moves.some((m) => m.captures.length > 0)) kill.push(f);
    if (moves.some((m) => isEscape(players, m))) escape.push(f);
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

export const diceWeights = (players: PlayerState[], color: Color, rng: Rng) => analyzeDice(players, color, rng).weights;

/** Samples a face 1-6 from the weights. */
export function sampleFace(weights: number[], rng: Rng): number {
  let r = rng();
  for (let i = 0; i < 5; i++) {
    r -= weights[i]!;
    if (r < 0) return i + 1;
  }
  return 6;
}

export const rollDice = (players: PlayerState[], color: Color, rng: Rng) => sampleFace(diceWeights(players, color, rng), rng);
