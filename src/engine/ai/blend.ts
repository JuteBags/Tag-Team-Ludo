// Extreme with Hard's rules folded in: a person's score is the net's score plus alpha times the readable
// rules' score, and a softmax over the people still playing gives the chances. alpha = 0 is the net alone.
// The two were trained for different things (the net to predict results, the rules tuned to win), so the
// blend can keep the best of both.
import type { GameState } from '../types';
import { encodeState } from './encode';
import type { Evaluator, LinearRules } from './linear';
import type { Net } from './net';

export class Blend implements Evaluator {
  constructor(private readonly net: Net, private readonly rules: LinearRules, private readonly alpha: number) {}

  ownerChances(state: GameState): Float64Array {
    const people = Math.max(...state.players.map((p) => p.owner)) + 1;
    const sn = this.net.ownerScores(encodeState(state), 0, state.players.map((p) => p.owner), people);
    const { s: sl, live } = this.rules.ownerScores(state);
    const s = new Float64Array(people);
    let top = -Infinity;
    for (let o = 0; o < people; o++) {
      s[o] = sn[o]! + this.alpha * sl[o]!;
      if (live[o]) top = Math.max(top, s[o]!);
    }
    let sum = 0;
    for (let o = 0; o < people; o++) sum += s[o] = live[o] ? Math.exp(s[o]! - top) : 0;
    for (let o = 0; o < people; o++) s[o]! /= sum;
    return s;
  }
}
