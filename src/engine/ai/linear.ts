// Readable rules for the rule bots: a person's strength is a weighted sum of the plain hand features of
// their colours (features.ts), and a softmax over the people still playing turns strengths into chances
// of winning. Each weight is one readable rule ("every step still to go costs w[pipsLeft]"). The
// weights are fitted to real game results (tools/ai/train.py --linear), then tuned for strength.
import { ownerRanking } from '../game';
import { isDone } from '../rules';
import type { GameState } from '../types';
import { F, FEATURES, stateFeatures } from './features';

export interface LinearJSON {
  kind: 'linear';
  /** Weight per hand feature, by name (missing names weigh 0). */
  weights: Record<string, number>;
}

/** Anything that gives each person's chance of winning from a position (Net, LinearRules). */
export interface Evaluator {
  ownerChances(state: GameState): Float64Array;
}

export class LinearRules implements Evaluator {
  readonly w: Float64Array;

  constructor(json: LinearJSON) {
    this.w = Float64Array.from(FEATURES, (f) => json.weights[f] ?? 0);
  }

  ownerChances(state: GameState): Float64Array {
    const people = Math.max(...state.players.map((p) => p.owner)) + 1;
    const f = stateFeatures(state);
    const s = new Float64Array(people);
    const live = new Array<boolean>(people).fill(false);
    state.players.forEach((p, i) => {
      for (let k = 0; k < F; k++) s[p.owner]! += this.w[k]! * f[i * F + k]!;
      if (!isDone(p)) live[p.owner] = true;
    });
    let top = -Infinity;
    for (let o = 0; o < people; o++) if (live[o]) top = Math.max(top, s[o]!);
    let sum = 0;
    for (let o = 0; o < people; o++) sum += s[o] = live[o] ? Math.exp(s[o]! - top) : 0;
    for (let o = 0; o < people; o++) s[o]! /= sum;
    return s;
  }

  winChance(state: GameState, owner: number): number {
    if (state.phase === 'over') return ownerRanking(state)[0] === owner ? 1 : 0;
    return this.ownerChances(state)[owner]!;
  }
}
