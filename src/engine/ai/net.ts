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
import type { BinNet } from './netbin';

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

/**
 * z = tanh(W a + b) reading only a's non-zero entries (`nz`, the first `n` of them, in order), for the first
 * trunk layer: a colour has 25-45 non-zero inputs of 182 (#125). Bit-identical to dense(): a skipped term
 * w * 0 is ±0, and adding ±0 changes a sum only when the sum is -0. Starting from the bias, a sum can only
 * be -0 if the bias is, so a row with a -0 bias sums densely.
 */
function sparseTanh(l: Layer, a: Float64Array, nz: Int32Array, n: number, z: Float64Array) {
  for (let r = 0; r < l.out; r++) {
    let s = l.b[r]!;
    const row = r * l.inn;
    if (Object.is(s, -0)) for (let c = 0; c < l.inn; c++) s += l.W[row + c]! * a[c]!;
    else
      for (let k = 0; k < n; k++) {
        const c = nz[k]!;
        s += l.W[row + c]! * a[c]!;
      }
    z[r] = Math.tanh(s);
  }
}

/** How many trunk vectors (and as many scores) the memo keeps before it starts over: about 3 MB. */
const MEMO_MAX = 1024;

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
  // Each colour's gathered inputs and their non-zero positions, for one call (up to 4 colours).
  private readonly gathered: Float64Array;
  private readonly nz: Int32Array;
  private readonly nzCount = new Int32Array(4);
  private readonly keys: string[] = ['', '', '', ''];
  private readonly ready = new Int32Array(4);
  // The memo (remember()): trunk vectors by a colour's exact inputs, and scores by a person's colours' inputs.
  private trunkMemo: Map<string, Float64Array> | null = null;
  private scoreMemo: Map<string, number> | null = null;

  /** From the training JSON, or from extreme-net.bin decoded (netbin.ts decodeNet: the same values, no JSON). */
  constructor(net: NetJSON | BinNet) {
    if (net.inputs instanceof Int32Array) {
      const bin = net as BinNet;
      this.inputs = bin.inputs;
      this.trunk = bin.trunk;
      this.pool = bin.pool;
      this.out = bin.out;
    } else {
      const json = net as NetJSON;
      this.inputs = Int32Array.from(json.inputs);
      this.trunk = json.trunk.map(layer);
      this.pool = layer(json.pool);
      this.out = layer(json.out);
    }
    this.hidden = this.trunk[this.trunk.length - 1]!.out;
    const widest = Math.max(this.inputs.length, ...this.trunk.map((l) => l.out));
    this.bufA = new Float64Array(widest);
    this.bufB = new Float64Array(widest);
    this.hs = new Float64Array(4 * this.hidden);
    this.pooled = new Float64Array(3 * this.hidden);
    this.z = new Float64Array(this.pool.out);
    this.gathered = new Float64Array(4 * this.inputs.length);
    this.nz = new Int32Array(4 * this.inputs.length);
  }

  /**
   * Keeps every trunk vector and score by its exact inputs, so a colour or person seen again costs a lookup
   * (#125: in the luck pass half the colours recur within a roll's six faces). Exact: the same inputs give
   * the same doubles. Bounded (MEMO_MAX); forget() between games. Off by default.
   */
  remember(on = true) {
    this.trunkMemo = on ? new Map() : null;
    this.scoreMemo = on ? new Map() : null;
  }

  /** Empties the memo (a new game). */
  forget() {
    this.trunkMemo?.clear();
    this.scoreMemo?.clear();
  }

  /** Gathers colour i's inputs (starting at `o` in `x`) and lists the non-zero ones; with the memo on, its key. */
  private gather(x: Float64Array, o: number, i: number) {
    const m = this.inputs.length;
    const a = this.gathered;
    let n = 0;
    for (let k = 0; k < m; k++) {
      const v = x[o + this.inputs[k]!]!;
      a[i * m + k] = v;
      if (v !== 0) this.nz[i * m + n++] = k;
    }
    this.nzCount[i] = n;
    if (this.trunkMemo) {
      let key = '';
      for (let j = 0; j < n; j++) {
        const k = this.nz[i * m + j]!;
        key += k + ':' + a[i * m + k] + ',';
      }
      this.keys[i] = key;
    }
  }

  /** Colour i's trunk vector (gathered first), written to hs at i * hidden. */
  private colour(i: number) {
    const H = this.hidden;
    const hit = this.trunkMemo?.get(this.keys[i]!);
    if (hit) {
      this.hs.set(hit, i * H);
      return;
    }
    const m = this.inputs.length;
    let a = this.bufA;
    let z = this.bufB;
    a.set(this.gathered.subarray(i * m, (i + 1) * m));
    sparseTanh(this.trunk[0]!, a, this.nz.subarray(i * m), this.nzCount[i]!, z);
    [a, z] = [z, a];
    for (let l = 1; l < this.trunk.length; l++) {
      dense(this.trunk[l]!, a, z, true);
      [a, z] = [z, a];
    }
    for (let k = 0; k < H; k++) this.hs[i * H + k] = a[k]!;
    if (this.trunkMemo) {
      if (this.trunkMemo.size >= MEMO_MAX) this.trunkMemo.clear();
      this.trunkMemo.set(this.keys[i]!, this.hs.slice(i * H, (i + 1) * H));
    }
  }

  /**
   * Each person's score from encoded inputs `x` (colour i at offset base + i * D), given each colour's
   * owner. People without a colour get NaN.
   */
  ownerScores(x: Float64Array, base: number, owners: ArrayLike<number>, people: number): Float64Array {
    const H = this.hidden;
    const n = owners.length;
    for (let i = 0; i < n; i++) {
      this.gather(x, base + i * D, i);
      this.ready[i] = 0;
    }
    const s = new Float64Array(people).fill(NaN);
    for (let o = 0; o < people; o++) {
      // With the memo on, a person whose colours' inputs were all seen before has a known score.
      let key = '';
      if (this.scoreMemo) {
        for (let i = 0; i < n; i++) if (owners[i] === o) key += this.keys[i] + '|';
        const hit = this.scoreMemo.get(key);
        if (hit !== undefined) {
          s[o] = hit;
          continue;
        }
      }
      let count = 0;
      for (let i = 0; i < n; i++) {
        if (owners[i] !== o) continue;
        if (!this.ready[i]) {
          this.colour(i);
          this.ready[i] = 1;
        }
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
      if (this.scoreMemo) {
        if (this.scoreMemo.size >= MEMO_MAX) this.scoreMemo.clear();
        this.scoreMemo.set(key, s[o]!);
      }
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
