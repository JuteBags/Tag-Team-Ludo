// The value net: a small MLP scores each colour from its inputs (encode.ts); a softmax over the colours
// still playing turns the scores into chances of finishing first (Plackett-Luce, as it was trained).
// Weights come from training (tools/ai/train.py) as JSON: the inputs it uses, then dense layers.
import { isDone } from '../rules';
import { ownerRanking } from '../game';
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

  constructor(json: NetJSON) {
    this.inputs = Int32Array.from(json.inputs);
    this.layers = json.layers.map((l) => ({ W: Float64Array.from(l.W.flat()), b: Float64Array.from(l.b), out: l.b.length, inn: l.W[0]!.length }));
  }

  /** Score of the colour whose inputs start at `o` in `x`. */
  score(x: Float64Array, o: number): number {
    let a = new Float64Array(this.inputs.length);
    for (let k = 0; k < a.length; k++) a[k] = x[o + this.inputs[k]!]!;
    this.layers.forEach((l, li) => {
      const z = new Float64Array(l.out);
      for (let r = 0; r < l.out; r++) {
        let s = l.b[r]!;
        const row = r * l.inn;
        for (let c = 0; c < l.inn; c++) s += l.W[row + c]! * a[c]!;
        z[r] = li < this.layers.length - 1 ? Math.tanh(s) : s;
      }
      a = z;
    });
    return a[0]!;
  }

  /** Each colour's chance of finishing first, in players order (0 for colours already home). */
  chances(state: GameState): number[] {
    const x = encodeState(state);
    const s = state.players.map((p, i) => (isDone(p) ? -Infinity : this.score(x, i * D)));
    const top = Math.max(...s);
    const e = s.map((v) => (v === -Infinity ? 0 : Math.exp(v - top)));
    const sum = e.reduce((a, b) => a + b, 0);
    return e.map((v) => v / sum);
  }

  /** Chance that `owner` wins: exact once the game is over; else the sum over their colours. */
  winChance(state: GameState, owner: number): number {
    if (state.phase === 'over') return ownerRanking(state)[0] === owner ? 1 : 0;
    const c = this.chances(state);
    return state.players.reduce((a, p, i) => a + (p.owner === owner ? c[i]! : 0), 0);
  }
}
