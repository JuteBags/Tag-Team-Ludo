// Extreme's thinking off the UI thread: the rollout engine (rollout.ts) in a Web Worker. Messages in:
// { id, state, nmax, seed }; out: { id, index } with index into state.moves, or { id, error }.
// The game review (#65): { id, kind: 'review', state, n, seed, ask? }; out: { id, values } (DecisionValues;
// with ask, the net screen or the race of #101).
// Its luck: { id, kind: 'luck', rec }; out: { id, luck, chances } (review.ts rollLuck and netChances, with the Extreme net).
import { PLAYOUT_RULES } from './playout-rules';
import { Net } from './net';
import { decodeNet } from './netbin';
import { replay, type GameRecord } from '../record';
import { netChances, rollLuck, type ReviewAsk } from './review';
import { RolloutEngine } from './rollout';
import wasmUrl from './ludo_wasm.wasm?url';
import netUrl from './extreme-net.bin?url';
import type { GameState } from '../types';

let engine: Promise<RolloutEngine> | null = null;
// The net's bytes (extreme-net.bin, #98), fetched once for both the engine and the luck net.
let netBytes: Promise<Uint8Array> | null = null;
const loadNet = () => (netBytes ??= fetch(netUrl).then(async (r) => new Uint8Array(await r.arrayBuffer())));

function load(): Promise<RolloutEngine> {
  engine ??= Promise.all([fetch(wasmUrl).then((r) => r.arrayBuffer()), loadNet()]).then(([wasm, net]) => RolloutEngine.create(wasm, net, PLAYOUT_RULES));
  return engine;
}

let luckNet: Net | null = null;

self.onmessage = async (e: MessageEvent<{ id: number; kind?: 'review' | 'luck'; state: GameState; nmax: number; n: number; seed: number; ask?: ReviewAsk; rec: GameRecord }>) => {
  const { id, kind, state, nmax, n, seed, ask } = e.data;
  try {
    if (kind === 'luck') {
      luckNet ??= new Net(decodeNet(await loadNet()));
      const r = replay(e.data.rec);
      self.postMessage({ id, luck: rollLuck(e.data.rec, r.states, luckNet), chances: netChances(e.data.rec, r.states, luckNet) });
      return;
    }
    if (kind === 'review') {
      self.postMessage({ id, values: (await load()).reviewFast(state, n, seed, ask) });
      return;
    }
    const m = (await load()).choose(state, nmax, seed);
    self.postMessage({ id, index: state.moves.indexOf(m) });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
