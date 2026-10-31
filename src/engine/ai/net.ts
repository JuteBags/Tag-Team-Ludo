// The value net: a small MLP scores each colour from its inputs (encode.ts), a person's score is the sum
// of their colours' scores (a person with two houses wins only when both are home), and a softmax over
// the people still playing turns the scores into chances of winning (Plackett-Luce, as it was trained).
// Weights come from training (tools/ai/train.py) as JSON: the inputs it reads, then dense layers.
import { ownerRanking } from '../game';
import { isDone } from '../rules';
import type { GameState } from '../types';
import { D, encodeState } from './encode';

export interface NetJSON {
  /** Indices into the D inputs that the net reads (e.g. only the hand features). */
  inputs: number[];
  /** Dense layers in order: W is out x in, tanh between layers, the last layer has one output. */
  layers: { W: number[][]; b: number[] }[];
}

export class Net {
  private readonly inputs: Int32Array;
  private readonly layers: { W: Float64Array; b: Float64Array; out: number; inn: number }[];
  // Scratch for the layer activations, reused by every call.
  private readonly bufA: Float64Array;
  private readonly bufB: Float64Array;

  constructor(json: NetJSON) {
    this.inputs = Int32Array.from(json.inputs);
    this.layers = json.layers.map((l) => ({ W: Float64Array.from(l.W.flat()), b: Float64Array.from(l.b), out: l.b.length, inn: l.W[0]!.length }));
    const widest = Math.max(this.inputs.length, ...this.layers.map((l) => l.out));
    this.bufA = new Float64Array(widest);
    this.bufB = new Float64Array(widest);
  }

  /** Score of the colour whose inputs start at `o` in `x`. */
  score(x: Float64Array, o: number): number {
    let a = this.bufA;
    let z = this.bufB;
    const n = this.inputs.length;
    for (let k = 0; k < n; k++) a[k] = x[o + this.inputs[k]!]!;
    const last = this.layers.length - 1;
    for (let li = 0; li <= last; li++) {
      const { W, b, out, inn } = this.layers[li]!;
      for (let r = 0; r < out; r++) {
        let s = b[r]!;
        const row = r * inn;
        for (let c = 0; c < inn; c++) s += W[row + c]! * a[c]!;
        z[r] = li < last ? Math.tanh(s) : s;
      }
      [a, z] = [z, a];
    }
    return a[0]!;
  }

  /** Each person's chance of winning, by owner (0 for people already home). */
  ownerChances(state: GameState): Float64Array {
    const owners = Math.max(...state.players.map((p) => p.owner)) + 1;
    const x = encodeState(state);
    const s = new Float64Array(owners);
    const live = new Array<boolean>(owners).fill(false);
    state.players.forEach((p, i) => {
      s[p.owner]! += this.score(x, i * D);
      if (!isDone(p)) live[p.owner] = true;
    });
    let top = -Infinity;
    for (let o = 0; o < owners; o++) if (live[o]) top = Math.max(top, s[o]!);
    let sum = 0;
    for (let o = 0; o < owners; o++) sum += s[o] = live[o] ? Math.exp(s[o]! - top) : 0;
    for (let o = 0; o < owners; o++) s[o]! /= sum;
    return s;
  }

  /** Chance that `owner` wins: exact once the game is over. */
  winChance(state: GameState, owner: number): number {
    if (state.phase === 'over') return ownerRanking(state)[0] === owner ? 1 : 0;
    return this.ownerChances(state)[owner]!;
  }
}
