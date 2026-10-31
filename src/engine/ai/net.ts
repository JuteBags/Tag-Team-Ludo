// The value net. A small MLP (the trunk) turns each colour's inputs (encode.ts) into a vector; a
// person's colours are pooled (sum, max and min, so one stranded colour shows: a person with two houses
// wins only when both are home) and a small head scores the person. A softmax over the people still
// playing turns the scores into chances of winning (Plackett-Luce, as it was trained).
// Weights come from training (tools/ai/train.py) as JSON.
import { ownerRanking } from '../game';
import { isDone } from '../rules';
import type { GameState } from '../types';
import { D, encodeState } from './encode';
import type { Evaluator } from './linear';

interface Dense {
  W: number[][];
  b: number[];
}

export interface NetJSON {
  /** Indices into the D inputs that the trunk reads (e.g. only the hand features). */
  inputs: number[];
  /** Trunk layers, tanh after each; W is out x in. */
  trunk: Dense[];
  /** Person head: tanh(pool . [sum, max, min] of the colours' trunk vectors), then `out` to one score. */
  pool: Dense;
  out: Dense;
}

interface Layer {
  W: Float64Array;
  b: Float64Array;
  out: number;
  inn: number;
}
const layer = (l: Dense): Layer => ({ W: Float64Array.from(l.W.flat()), b: Float64Array.from(l.b), out: l.b.length, inn: l.W[0]!.length });

/** z = act(W a + b). */
function dense(l: Layer, a: Float64Array, z: Float64Array, tanh: boolean) {
  for (let r = 0; r < l.out; r++) {
    let s = l.b[r]!;
    const row = r * l.inn;
    for (let c = 0; c < l.inn; c++) s += l.W[row + c]! * a[c]!;
    z[r] = tanh ? Math.tanh(s) : s;
  }
}

export class Net implements Evaluator {
  private readonly inputs: Int32Array;
  private readonly trunk: Layer[];
  private readonly pool: Layer;
  private readonly out: Layer;
  /** Width of a colour's trunk vector. */
  readonly hidden: number;
  // Scratch reused by every call.
  private readonly bufA: Float64Array;
  private readonly bufB: Float64Array;
  private readonly hs: Float64Array;
  private readonly pooled: Float64Array;
  private readonly z: Float64Array;
  private readonly one = new Float64Array(1);

  constructor(json: NetJSON) {
    this.inputs = Int32Array.from(json.inputs);
    this.trunk = json.trunk.map(layer);
    this.pool = layer(json.pool);
    this.out = layer(json.out);
    this.hidden = this.trunk[this.trunk.length - 1]!.out;
    const widest = Math.max(this.inputs.length, ...this.trunk.map((l) => l.out));
    this.bufA = new Float64Array(widest);
    this.bufB = new Float64Array(widest);
    this.hs = new Float64Array(4 * this.hidden);
    this.pooled = new Float64Array(3 * this.hidden);
    this.z = new Float64Array(this.pool.out);
  }

  /** The trunk vector of the colour whose inputs start at `o` in `x`, written to `dst` at `at`. */
  private colour(x: Float64Array, o: number, dst: Float64Array, at: number) {
    let a = this.bufA;
    let z = this.bufB;
    for (let k = 0; k < this.inputs.length; k++) a[k] = x[o + this.inputs[k]!]!;
    for (const l of this.trunk) {
      dense(l, a, z, true);
      [a, z] = [z, a];
    }
    for (let k = 0; k < this.hidden; k++) dst[at + k] = a[k]!;
  }

  /**
   * Each person's score from encoded inputs `x` (colour i at offset base + i * D), given each colour's
   * owner. People without a colour get NaN.
   */
  ownerScores(x: Float64Array, base: number, owners: ArrayLike<number>, people: number): Float64Array {
    const H = this.hidden;
    const n = owners.length;
    for (let i = 0; i < n; i++) this.colour(x, base + i * D, this.hs, i * H);
    const s = new Float64Array(people).fill(NaN);
    for (let o = 0; o < people; o++) {
      let count = 0;
      for (let i = 0; i < n; i++) {
        if (owners[i] !== o) continue;
        for (let k = 0; k < H; k++) {
          const v = this.hs[i * H + k]!;
          if (count === 0) {
            this.pooled[k] = v;
            this.pooled[H + k] = v;
            this.pooled[2 * H + k] = v;
          } else {
            this.pooled[k]! += v;
            this.pooled[H + k] = Math.max(this.pooled[H + k]!, v);
            this.pooled[2 * H + k] = Math.min(this.pooled[2 * H + k]!, v);
          }
        }
        count++;
      }
      if (!count) continue;
      dense(this.pool, this.pooled, this.z, true);
      dense(this.out, this.z, this.one, false);
      s[o] = this.one[0]!;
    }
    return s;
  }

  /** Each person's chance of winning, by owner (0 for people already home). */
  ownerChances(state: GameState): Float64Array {
    const people = Math.max(...state.players.map((p) => p.owner)) + 1;
    const s = this.ownerScores(encodeState(state), 0, state.players.map((p) => p.owner), people);
    const live = new Array<boolean>(people).fill(false);
    for (const p of state.players) if (!isDone(p)) live[p.owner] = true;
    let top = -Infinity;
    for (let o = 0; o < people; o++) if (live[o]) top = Math.max(top, s[o]!);
    let sum = 0;
    for (let o = 0; o < people; o++) sum += s[o] = live[o] ? Math.exp(s[o]! - top) : 0;
    for (let o = 0; o < people; o++) s[o]! /= sum;
    return s;
  }

  /** Chance that `owner` wins: exact once the game is over. */
  winChance(state: GameState, owner: number): number {
    if (state.phase === 'over') return ownerRanking(state)[0] === owner ? 1 : 0;
    return this.ownerChances(state)[owner]!;
  }
}
