// The roll's strip (#194): the roller's win chance after each face 1–6 with best play, on the review's own
// playout scale, so the strip and the move's verdict (its gaps, from the same playouts) can't disagree. It is
// review.ts chanceAfter with playouts in place of the net: a decision is valued by its review (the best
// candidate's mean); a forced move, a turn that passes, or a roll still to come by value() (the review's own
// playouts from that position); after a 6, the fair expectation over the next face, one step on.
import { move, roll } from '../game';
import type { GameState } from '../types';
import type { DecisionValues } from './review';

/** What the strip needs from the engine (RolloutEngine; the worker's). */
export interface PlayoutEngine {
  review(state: GameState, n: number, seed: number): DecisionValues;
  value(state: GameState, n: number, seed: number, owner: number): number;
}

/** Each face's own seed, so the six values are independent of each other. */
const faceSeed = (seed: number, face: number, inner = 0) => (seed + 7919 * face + 104729 * inner) >>> 0;

/** The roller's chance after `face` at the roll state `s`, with best play (review.ts chanceAfter, by playouts). */
export function chanceAfterByPlayouts(e: PlayoutEngine, s: GameState, face: number, n: number, seed: number, step = true): number {
  const owner = s.players[s.current]!.owner;
  const t = roll(s, () => 0, face);
  if (t.phase === 'move' && t.current === s.current) {
    if (new Set(t.moves.map((m) => JSON.stringify(move(t, m).players.map((p) => p.tokens)))).size > 1) return Math.max(...e.review(t, n, seed).mean);
    // One position to reach (a forced move, or moves that land the same): its value.
    return e.value(move(t, t.moves[0]!), n, seed, owner);
  }
  if (step && t.phase === 'roll' && t.current === s.current) {
    let x = 0;
    for (let f = 1; f <= 6; f++) x += chanceAfterByPlayouts(e, t, f, n, faceSeed(seed, face, f), false) / 6;
    return x;
  }
  return e.value(t, n, seed, owner);
}

/**
 * The roller's chance after each face 1..6 at the roll state `pre`. `rolled`: the face rolled and its value as
 * the puzzle shows it (its best move's chance), taken as it is, so the strip's rolled face is the verdict's.
 */
export function facesByPlayouts(e: PlayoutEngine, pre: GameState, n: number, seed: number, rolled?: { face: number; chance: number }): number[] {
  return [1, 2, 3, 4, 5, 6].map((f) => (rolled && f === rolled.face ? rolled.chance : chanceAfterByPlayouts(e, pre, f, n, faceSeed(seed, f))));
}

/** The strip's numbers: the win chance before the roll (each face weighted by the dice), and what the roll did. */
export function rollEffect(faces: number[], weights: number[], face: number): { before: number; roll: number } {
  const sum = weights.reduce((a, w) => a + w, 0) || 1;
  const before = faces.reduce((a, v, k) => a + (v * weights[k]!) / sum, 0);
  return { before, roll: faces[face - 1]! - before };
}
