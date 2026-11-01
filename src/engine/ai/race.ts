// Exact race database, v1: positions where every token still in play (of every colour) is in its home
// column. Nobody can capture or block anyone any more, so each colour's future is its own: a small
// dynamic programme over its tokens' distances to the centre (1-5) and the turn rules (the tray, a 6
// rolls again and is useless here, three 6s cancel, a token reaching the centre rolls again, unusable
// dice are lost). Fair dice (1/6 per face): the engine's own model, used in play only, never as labels.
//
// Per colour: the play that minimises the expected number of turns to finish, and under it the exact
// distribution of how many own turns it takes. Colours then finish independently; a colour's k-th turn
// comes in round k at its seat, so finishing events order by (turns, seat from the current colour) and
// each person's chance of being first follows exactly. The same arithmetic, in the same order, is in
// sim-rs/src/race.rs, so both give the same bits.
import { FINISHED, HOME_FIRST } from '../board';
import { isDone } from '../rules';
import type { GameState } from '../types';

/** Turns tracked per distribution (the mass beyond is below 1e-20). */
export const NMAX = 256;

/** A colour's state: how many tokens sit at distance 1..5 from the centre. */
type Counts = number[];
type Out = [number, Float64Array];

const key = (c: Counts) => c[0]! + 5 * c[1]! + 25 * c[2]! + 125 * c[3]! + 625 * c[4]!;
const pips = (c: Counts) => c[0]! * 1 + c[1]! * 2 + c[2]! * 3 + c[3]! * 4 + c[4]! * 5;

function allStates(): Counts[] {
  const v: Counts[] = [];
  for (let a = 0; a <= 4; a++)
    for (let b = 0; b <= 4 - a; b++)
      for (let c = 0; c <= 4 - a - b; c++)
        for (let d = 0; d <= 4 - a - b - c; d++) for (let e = 0; e <= 4 - a - b - c - d; e++) v.push([a, b, c, d, e]);
  return v.sort((x, y) => pips(x) - pips(y) || key(x) - key(y));
}

/** One roll run: the face that ends it (1-5, after any useless 6s) or three 6s; `s` 6s already rolled. */
function runProbs(s: number): [number, number] {
  return s === 0 ? [43 / 216, 1 / 216] : s === 1 ? [7 / 36, 1 / 36] : [1 / 6, 1 / 6];
}

class Turn {
  private readonly memo = new Map<string, Out>();
  constructor(
    private readonly db: RaceDb,
    private readonly endValue: (j: number) => number,
  ) {}

  private end(c: Counts): Out {
    const i = this.db.idx[key(c)]!;
    const d = new Float64Array(this.db.states.length);
    d[i] = 1;
    return [this.endValue(i), d];
  }

  /** A roll run, then play (`s` 6s already in this run). */
  run(c: Counts, tray: Counts, s: number): Out {
    const k = `${key(c)}|${tray.join('')}|${10 + s}`;
    const hit = this.memo.get(k);
    if (hit) return hit;
    const [p, cancel] = runProbs(s);
    let val = 0;
    const dist = new Float64Array(this.db.states.length);
    for (let r = 1; r <= 5; r++) {
      const t = [...tray];
      t[r - 1]!++;
      const [v, d] = this.play(c, t);
      val += p * v;
      for (let j = 0; j < dist.length; j++) dist[j]! += p * d[j]!;
    }
    // three 6s: the dice kept from before the run are played
    const [v, d] = this.play(c, tray);
    val += cancel * v;
    for (let j = 0; j < dist.length; j++) dist[j]! += cancel * d[j]!;
    const out: Out = [val, dist];
    this.memo.set(k, out);
    return out;
  }

  /** Play the tray: the move with the lowest expected future turns (first such, die high first then
   * distance low first), or end the turn when nothing can move. */
  play(c: Counts, tray: Counts): Out {
    const k = `${key(c)}|${tray.join('')}|0`;
    const hit = this.memo.get(k);
    if (hit) return hit;
    let best: Out | null = null;
    for (let r = 5; r >= 1; r--) {
      if (tray[r - 1] === 0) continue;
      for (let d = r; d <= 5; d++) {
        if (c[d - 1] === 0) continue;
        const c2 = [...c];
        c2[d - 1]!--;
        const finished = d === r;
        if (!finished) c2[d - r - 1]!++;
        const t2 = [...tray];
        t2[r - 1]!--;
        const done = c2.every((x) => x === 0);
        const out = done ? this.end(c2) : finished ? this.run(c2, t2, 0) : this.play(c2, t2);
        if (best === null || out[0] < best[0]) best = out;
      }
    }
    const res = best ?? this.end(c);
    this.memo.set(k, res);
    return res;
  }
}

export class RaceDb {
  readonly idx: Int32Array = new Int32Array(3125).fill(-1);
  readonly states: Counts[] = allStates();
  /** Expected own turns to finish from a turn start. */
  readonly exp: Float64Array;
  /** dist[s][n]: probability of finishing on own turn n (n >= 1) from a turn start. */
  readonly dist: Float64Array[];

  private constructor() {
    const n = this.states.length;
    this.states.forEach((s, i) => (this.idx[key(s)] = i));
    this.exp = new Float64Array(n);
    this.dist = this.states.map(() => new Float64Array(NMAX));
    this.dist[0]![0] = 1; // states[0] is the empty colour: done
    for (let i = 1; i < n; i++) {
      const c = this.states[i]!;
      const snapshot = Float64Array.from(this.exp);
      const t = new Turn(this, (j) => snapshot[j]!);
      const [p, cancel] = runProbs(0);
      let pSelf = 0;
      let fut = 0;
      const q = new Float64Array(n);
      for (let r = 1; r <= 5; r++) {
        let canMove = false;
        for (let d = r; d <= 5; d++) if (c[d - 1]! > 0) canMove = true;
        if (!canMove) {
          pSelf += p;
          continue;
        }
        const tray = [0, 0, 0, 0, 0];
        tray[r - 1] = 1;
        const [v, d] = t.play(c, tray);
        fut += p * v;
        for (let j = 0; j < n; j++) q[j]! += p * d[j]!;
      }
      pSelf += cancel;
      this.exp[i] = (1 + fut) / (1 - pSelf);
      const dist = new Float64Array(NMAX);
      for (let m = 1; m < NMAX; m++) {
        let s = pSelf * dist[m - 1]!;
        for (let j = 0; j < i; j++) s += q[j]! * this.dist[j]![m - 1]!;
        dist[m] = s;
      }
      this.dist[i] = dist;
    }
  }

  private static db: RaceDb | null = null;
  static get(): RaceDb {
    return (RaceDb.db ??= new RaceDb());
  }

  /** Own turns to finish for the colour about to act; the rest of this turn (tray, 6s in the current
   * run, a roll pending) counts as turn 1. */
  currentDist(c: Counts, tray: Counts, sixes: number): Float64Array {
    const n = this.states.length;
    const t = new Turn(this, (j) => this.exp[j]!);
    const q = t.run(c, tray, sixes)[1];
    const dist = new Float64Array(NMAX);
    for (let m = 1; m < NMAX; m++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += q[j]! * this.dist[j]![m - 1]!;
      dist[m] = s;
    }
    return dist;
  }

  /** The move (index into state.moves) with the lowest expected future turns, in a v1 race position. */
  move(state: GameState): number {
    const c = homeCounts(state.players[state.current]!.tokens)!;
    const tray = trayCounts(state.rolls);
    const t = new Turn(this, (j) => this.exp[j]!);
    let best = Infinity;
    let at = 0;
    state.moves.forEach((m, k) => {
      const r = m.roll;
      const d = FINISHED - m.from;
      const c2 = [...c];
      c2[d - 1]!--;
      const finished = d === r;
      if (!finished) c2[d - r - 1]!++;
      const t2 = [...tray];
      t2[r - 1]!--;
      const v = c2.every((x) => x === 0) ? 0 : finished ? t.run(c2, t2, 0)[0] : t.play(c2, t2)[0];
      if (v < best) {
        best = v;
        at = k;
      }
    });
    return at;
  }
}

/** A colour's distances to the centre, if all its tokens are in the home column or finished. */
function homeCounts(tokens: number[]): Counts | null {
  const c = [0, 0, 0, 0, 0];
  for (const t of tokens) {
    if (t === FINISHED) continue;
    if (t < HOME_FIRST) return null;
    c[FINISHED - t - 1]!++;
  }
  return c;
}

const trayCounts = (rolls: number[]): Counts => {
  const c = [0, 0, 0, 0, 0];
  for (const r of rolls) if (r <= 5) c[r - 1]!++;
  return c;
};

/** Each person's chance of finishing first (among people still playing) in a v1 race position before a
 * roll; null otherwise. */
export function raceChances(state: GameState): Float64Array | null {
  if (state.phase !== 'roll') return null;
  const ps = state.players;
  const n = ps.length;
  const counts: Counts[] = [];
  for (const p of ps) {
    const c = homeCounts(p.tokens);
    if (!c) return null;
    counts.push(c);
  }
  const db = RaceDb.get();
  const tray = trayCounts(state.rolls);
  const dists = ps.map((p, i) => (isDone(p) ? null : i === state.current ? db.currentDist(counts[i]!, tray, state.sixes) : db.dist[db.idx[key(counts[i]!)]!]!));
  const people = Math.max(...ps.map((p) => p.owner)) + 1;
  const seat = (i: number) => (i + n - state.current) % n;
  // F_p over keys k = (turns, seat) in order: the product of the person's live colours' CDFs
  const nk = NMAX * n;
  const f = Array.from({ length: people }, () => new Float64Array(nk).fill(1));
  const live = new Array<boolean>(people).fill(false);
  for (let i = 0; i < n; i++) {
    const d = dists[i];
    if (!d) continue;
    const o = ps[i]!.owner;
    live[o] = true;
    let below = 0;
    for (let t = 0; t < NMAX; t++) {
      for (let s = 0; s < n; s++) f[o]![t * n + s]! *= seat(i) <= s ? below + d[t]! : below;
      below += d[t]!;
    }
  }
  const out = new Float64Array(people);
  let total = 0;
  for (let p = 0; p < people; p++) {
    if (!live[p]) continue;
    let acc = 0;
    let prev = 0;
    for (let k = 0; k < nk; k++) {
      const pk = f[p]![k]! - prev;
      prev = f[p]![k]!;
      if (pk === 0) continue;
      let others = 1;
      for (let q = 0; q < people; q++) if (q !== p && live[q]) others *= 1 - f[q]![k]!;
      acc += pk * others;
    }
    out[p] = acc;
    total += acc;
  }
  for (let p = 0; p < people; p++) out[p]! /= total;
  return out;
}
