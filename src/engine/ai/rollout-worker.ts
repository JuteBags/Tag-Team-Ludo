// Extreme's thinking off the UI thread: the rollout engine (rollout.ts) in a Web Worker. Messages in:
// { id, state, nmax, seed }; out: { id, index } with index into state.moves, or { id, error }.
import { HARD_RULES } from './hard-rules';
import type { NetJSON } from './net';
import { RolloutEngine } from './rollout';
import wasmUrl from './ludo_wasm.wasm?url';
import type { GameState } from '../types';

let engine: Promise<RolloutEngine> | null = null;

function load(): Promise<RolloutEngine> {
  engine ??= Promise.all([fetch(wasmUrl).then((r) => r.arrayBuffer()), import('./extreme-net.json')]).then(([wasm, net]) =>
    RolloutEngine.create(wasm, net.default as unknown as NetJSON, HARD_RULES),
  );
  return engine;
}

self.onmessage = async (e: MessageEvent<{ id: number; state: GameState; nmax: number; seed: number }>) => {
  const { id, state, nmax, seed } = e.data;
  try {
    const m = (await load()).choose(state, nmax, seed);
    self.postMessage({ id, index: state.moves.indexOf(m) });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
