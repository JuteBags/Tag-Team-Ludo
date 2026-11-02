// Extreme's thinking off the UI thread: the rollout engine (rollout.ts) in a Web Worker. Messages in:
// { id, state, nmax, seed }; out: { id, index } with index into state.moves, or { id, error }.
// The game review (#65): { id, kind: 'review', state, n, seed }; out: { id, values } (DecisionValues).
import { PLAYOUT_RULES } from './playout-rules';
import type { NetJSON } from './net';
import { RolloutEngine } from './rollout';
import wasmUrl from './ludo_wasm.wasm?url';
import type { GameState } from '../types';

let engine: Promise<RolloutEngine> | null = null;

function load(): Promise<RolloutEngine> {
  engine ??= Promise.all([fetch(wasmUrl).then((r) => r.arrayBuffer()), import('./extreme-net.json')]).then(([wasm, net]) =>
    RolloutEngine.create(wasm, net.default as unknown as NetJSON, PLAYOUT_RULES),
  );
  return engine;
}

self.onmessage = async (e: MessageEvent<{ id: number; kind?: 'review'; state: GameState; nmax: number; n: number; seed: number }>) => {
  const { id, kind, state, nmax, n, seed } = e.data;
  try {
    if (kind === 'review') {
      self.postMessage({ id, values: (await load()).review(state, n, seed) });
      return;
    }
    const m = (await load()).choose(state, nmax, seed);
    self.postMessage({ id, index: state.moves.indexOf(m) });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
