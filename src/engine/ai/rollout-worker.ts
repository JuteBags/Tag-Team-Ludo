// Extreme's thinking off the UI thread: the rollout engine (rollout.ts) in a Web Worker. Messages in:
// { id, state, nmax, seed }; out: { id, index } with index into state.moves, or { id, error }.
// The game review (#65): { id, kind: 'review', state, n, seed, ask? }; out: { id, values } (DecisionValues;
// with ask, the net screen or the race of #101).
// Its luck (#125), a chunk at a time so a review can stop (or a verdict go first) between chunks:
//   { id, kind: 'luck-begin', rec }            out: { id, run, states }  (a new pass; any older one ends)
//   { id, kind: 'luck-chunk', run, from, to }  out: { id, luck, chances } for states[from, to)
//   { id, kind: 'luck-end', run }              out: { id, memory }  (frees the pass; a stale run is a no-op)
// Its memory (#151, the bench): { id, kind: 'memory' }; out: { id, bytes } (the wasm memory; 0 before the engine loads).
// or the whole game at once: { id, kind: 'luck', rec }; out: { id, luck, chances, memory }. The values come from
// the WebAssembly engine (luck.ts wasmLuck), or from the net in JS (netLuck) where the module can't run.
import { PLAYOUT_RULES } from './playout-rules';
import { Net } from './net';
import { decodeNet } from './netbin';
import { replay, type GameRecord } from '../record';
import { LUCK_CHUNK, luckChunk, luckPass, netLuck, wasmLuck, type LuckSource } from './luck';
import type { ReviewAsk } from './review';
import { RolloutEngine } from './rollout';
import { wasmUrl } from './wasmModule';
import netUrl from './extreme-net.bin?url';
import type { GameState } from '../types';

let engine: Promise<RolloutEngine> | null = null;
// The net's bytes (extreme-net.bin, #98), fetched once for both the engine and the luck net.
let netBytes: Promise<Uint8Array> | null = null;
const loadNet = () => (netBytes ??= fetch(netUrl).then(async (r) => new Uint8Array(await r.arrayBuffer())));

function load(): Promise<RolloutEngine> {
  engine ??= Promise.all([fetch(wasmUrl()).then((r) => r.arrayBuffer()), loadNet()]).then(([wasm, net]) => RolloutEngine.create(wasm, net, PLAYOUT_RULES));
  return engine;
}

let luckNet: Net | null = null;

/** Where this worker's luck values come from: the engine when it loads and has the luck pass, else the JS net. */
async function luckSource(): Promise<{ src: LuckSource; engine: RolloutEngine | null }> {
  const e = await load().catch(() => null);
  if (e?.hasLuck) return { src: wasmLuck(e), engine: e };
  if (!luckNet) {
    luckNet = new Net(decodeNet(await loadNet()));
    // Exact memo (#127): half the colours recur within a roll's six faces; emptied per game.
    luckNet.remember();
  }
  return { src: netLuck(luckNet), engine: null };
}

/** The game whose luck pass is under way (one at a time: the module has one leaf cache). */
let pass: { run: number; rec: GameRecord; states: GameState[]; src: LuckSource; engine: RolloutEngine | null } | null = null;
let runs = 0;
const endPass = () => {
  pass?.src.end();
  pass = null;
};

type Msg = { id: number; kind?: 'review' | 'luck' | 'luck-begin' | 'luck-chunk' | 'luck-end' | 'memory'; state: GameState; nmax: number; n: number; seed: number; ask?: ReviewAsk; rec: GameRecord; run: number; from: number; to: number };

self.onmessage = async (e: MessageEvent<Msg>) => {
  const { id, kind, state, nmax, n, seed, ask } = e.data;
  try {
    if (kind === 'luck-begin') {
      const { src, engine: eng } = await luckSource();
      endPass();
      const states = replay(e.data.rec).states as GameState[];
      src.begin();
      pass = { run: ++runs, rec: e.data.rec, states, src, engine: eng };
      self.postMessage({ id, run: pass.run, states: states.length });
      return;
    }
    if (kind === 'luck-chunk') {
      if (pass?.run !== e.data.run) throw new Error('this luck pass has ended');
      self.postMessage({ id, ...luckChunk(pass.src, pass.rec, pass.states, e.data.from, Math.min(e.data.to, pass.states.length)) });
      return;
    }
    if (kind === 'memory') {
      // The bench's memory line (#151): this worker's wasm memory, if its engine is loaded.
      const e2 = engine ? await engine.catch(() => null) : null;
      self.postMessage({ id, bytes: e2?.luckMemory.bytes ?? 0 });
      return;
    }
    if (kind === 'luck-end') {
      const memory = pass?.engine?.luckMemory;
      if (pass?.run === e.data.run) endPass();
      self.postMessage({ id, memory });
      return;
    }
    if (kind === 'luck') {
      const { src, engine: eng } = await luckSource();
      endPass();
      const r = luckPass(src, e.data.rec, replay(e.data.rec).states as GameState[], LUCK_CHUNK);
      self.postMessage({ id, ...r, memory: eng?.luckMemory });
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
