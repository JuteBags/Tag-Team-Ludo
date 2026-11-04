// The review's luck pass a chunk at a time (#125): the luck of every judged roll and the win-chance bar at
// every state, from either source of values:
//   wasmLuck  the WebAssembly engine (sim-wasm luck_*, the engine already loaded with the shipped net), with
//             a leaf cache for the game in the module;
//   netLuck   the net in JS (#127's sparse, remembered Net): the fallback where the module can't run.
// Both give the same doubles. The luck arithmetic (the faces' chances, the expectation, the sd, the bar's
// rounding) is review.ts's alone. The worker runs it in chunks so a review can stop, or a verdict go first,
// between them.
import type { GameRecord } from '../record';
import type { GameState } from '../types';
import type { Net } from './net';
import { barChances, faceValues, isJudgedRoll, LUCK_CHUNK, luckFrom, markSixRuns, peopleIn, type RollLuck } from './review';
import type { RolloutEngine } from './rollout';
import { ownerValues } from './search';

export { LUCK_CHUNK };

/** Where a game's luck values come from: begin, then any number of chunks, then end. */
export interface LuckSource {
  begin(): void;
  /** The roller's chance after each face 1..6, per roll state. */
  faces(states: GameState[]): number[][];
  /** Everyone's chance by owner, per state (ownerValues). */
  owners(states: GameState[], people: number): ArrayLike<number>[];
  end(): void;
}

export const wasmLuck = (e: RolloutEngine): LuckSource => ({
  begin: () => e.luckBegin(),
  faces: (ss) => {
    const v = e.luckChunk(ss, 0);
    return ss.map((_, k) => Array.from(v.subarray(6 * k, 6 * k + 6)));
  },
  owners: (ss) => {
    const v = e.luckChunk(ss, 1);
    return ss.map((_, k) => v.subarray(4 * k, 4 * k + 4));
  },
  end: () => e.luckEnd(),
});

export const netLuck = (net: Net): LuckSource => ({
  begin: () => net.forget(),
  faces: (ss) => ss.map((s) => faceValues(net, s)),
  owners: (ss, people) => ss.map((s) => ownerValues(net, s, people)),
  end: () => net.forget(),
});

/** One chunk, states[from, to): the luck of the judged rolls in it and the bar's chances at each of its states. */
export function luckChunk(src: LuckSource, rec: GameRecord, states: GameState[], from: number, to: number): { luck: RollLuck[]; chances: number[][] } {
  const people = peopleIn(rec);
  const rolls: number[] = [];
  for (let i = from; i < to; i++) if (isJudgedRoll(states, i)) rolls.push(i);
  const fv = rolls.length ? src.faces(rolls.map((i) => states[i]!)) : [];
  return {
    luck: rolls.map((i, k) => luckFrom(rec, states, i, fv[k]!)),
    chances: src.owners(states.slice(from, to), people).map((v) => barChances(v, people)),
  };
}

/** A whole game's luck pass in chunks: review.ts rollLuck and netChances, the same values. */
export function luckPass(src: LuckSource, rec: GameRecord, states: GameState[], chunk = LUCK_CHUNK): { luck: RollLuck[]; chances: number[][] } {
  const luck: RollLuck[] = [];
  const chances: number[][] = [];
  src.begin();
  try {
    for (let from = 0; from < states.length; from += chunk) {
      const r = luckChunk(src, rec, states, from, Math.min(states.length, from + chunk));
      luck.push(...r.luck);
      chances.push(...r.chances);
    }
  } finally {
    src.end();
  }
  return { luck: markSixRuns(states, luck), chances };
}
