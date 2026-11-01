// Readable rules for the rule bots: a person's strength is a weighted sum of the plain hand features of
// their colours (features.ts), and a softmax over the people still playing turns strengths into chances
// of winning. Each weight is one readable rule ("every step still to go costs w[pipsLeft]"). The
// weights are fitted to real game results (tools/ai/train.py --linear), then tuned for strength.
// The turn in progress counts too, for the person about to roll: each die still in the tray (by face) and
// the 6s rolled in a row, as in encode.ts, so a mid-turn position is not judged as if the tray were empty.
import { FINISHED } from '../board';
import { ownerRanking } from '../game';
import { isDone } from '../rules';
import type { GameState } from '../types';
import { F, FEATURES, stateFeatures } from './features';

/** The turn-in-progress rules: dice in the tray by face (count / 3) and 6s in a row (/ 2). */
export const TURN_RULES = ['tray1', 'tray2', 'tray3', 'tray4', 'tray5', 'tray6', 'sixes'] as const;

/** Rules for the readable rules only (never net inputs), per colour (extraRules). */
export const EXTRA_RULES = ['rollActive', 'rollBase', 'rollColumn', 'rollPrey', 'leadGap'] as const;

/**
 * One colour's extra rules from its hand features `f` (from offset `o`) and its tokens:
 * rollActive = turn0 * (1 - base - home), rollBase = turn0 * base, rollColumn = turn0 * column,
 * rollPrey = turn0 * prey (the colour rolls next: worth more or less by what it has to play with),
 * leadGap = (1st - 2nd highest progress + 1 among unfinished tokens) / 56, 0 with fewer than 2.
 */
export function extraRules(f: Float64Array, o: number, tokens: readonly number[]): number[] {
  const turn0 = f[o + 14]!;
  let p1 = -1, p2 = -1, live = 0;
  for (const t of tokens) {
    if (t === FINISHED) continue;
    live++;
    const p = t + 1;
    if (p > p1) { p2 = p1; p1 = p; } else if (p > p2) p2 = p;
  }
  const gap = live >= 2 ? (p1 - p2) / 56 : 0;
  return [turn0 * (1 - f[o + 1]! - f[o + 2]!), turn0 * f[o + 1]!, turn0 * f[o + 3]!, turn0 * f[o + 6]!, gap];
}

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
  readonly turn: Float64Array;
  readonly extra: Float64Array;

  constructor(json: LinearJSON) {
    this.w = Float64Array.from(FEATURES, (f) => json.weights[f] ?? 0);
    this.turn = Float64Array.from(TURN_RULES, (f) => json.weights[f] ?? 0);
    this.extra = Float64Array.from(EXTRA_RULES, (f) => json.weights[f] ?? 0);
  }

  /** Each person's score (the softmax input) and who is still playing. */
  ownerScores(state: GameState): { s: Float64Array; live: boolean[] } {
    const people = Math.max(...state.players.map((p) => p.owner)) + 1;
    const f = stateFeatures(state);
    const s = new Float64Array(people);
    const live = new Array<boolean>(people).fill(false);
    state.players.forEach((p, i) => {
      for (let k = 0; k < F; k++) s[p.owner]! += this.w[k]! * f[i * F + k]!;
      if (!isDone(p)) live[p.owner] = true;
    });
    const me = state.players[state.current]!.owner;
    for (const r of state.rolls) s[me]! += this.turn[r - 1]! / 3;
    s[me]! += (this.turn[6]! * state.sixes) / 2;
    // the extra rules, only when some weigh anything (older rule files stay bit-identical)
    if (this.extra.some((x) => x !== 0)) {
      state.players.forEach((p, i) => {
        const e = extraRules(f, i * F, p.tokens);
        for (let k = 0; k < EXTRA_RULES.length; k++) s[p.owner]! += this.extra[k]! * e[k]!;
      });
    }
    return { s, live };
  }

  ownerChances(state: GameState): Float64Array {
    const { s, live } = this.ownerScores(state);
    const people = s.length;
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
