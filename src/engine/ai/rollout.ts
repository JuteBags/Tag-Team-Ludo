// The rollout Extreme: sim-rs's adaptive rollout player (rollout.rs choose_race) compiled to WebAssembly
// (sim-wasm/ on feat/rollout-app; ludo_wasm.wasm). At each decision every distinct move is played out
// many times on shared dice (Hard's rules play every seat for 12 turns, then the Extreme net scores the
// position); clearly worse moves stop early, close calls get up to `nmax` playouts each, and Hard's own
// move is left only for a significant paired gain.
import { COLORS } from '../board';
import type { GameState, Move } from '../types';
import type { LinearJSON } from './linear';
import type { NetJSON } from './net';

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  init(net: number, netLen: number, rules: number, rulesLen: number): number;
  choose(state: number, len: number, nmax: number, seed: number): number;
  moves_len(state: number, len: number): number;
}

const PHASES = { roll: 0, move: 1, over: 2 } as const;

/** The state as sim-wasm's decode reads it (layout in sim-wasm/src/lib.rs). */
export function encodeState(s: GameState): Uint8Array {
  const out = new Uint8Array(15 + s.rolls.length + 6 * s.players.length);
  out[0] = s.players.length;
  out[1] = s.singles ? 1 : 0;
  out[2] = s.current;
  out[3] = PHASES[s.phase];
  out[4] = s.rolls.length;
  out[5] = s.sixes;
  out[6] = s.ranking.length;
  s.ranking.forEach((c, i) => (out[7 + i] = COLORS.indexOf(c)));
  new DataView(out.buffer).setUint32(11, s.turnCount, true);
  out.set(s.rolls, 15);
  let o = 15 + s.rolls.length;
  for (const p of s.players) {
    out[o] = COLORS.indexOf(p.color);
    out[o + 1] = p.owner;
    p.tokens.forEach((t, i) => (out[o + 2 + i] = t & 0xff));
    o += 6;
  }
  return out;
}

export class RolloutEngine {
  private constructor(private readonly x: Exports) {}

  /** Instantiates the module and loads the leaf net and Hard's rules into it. */
  static async create(wasm: BufferSource, net: NetJSON, rules: LinearJSON): Promise<RolloutEngine> {
    const { instance } = await WebAssembly.instantiate(wasm, {});
    const e = new RolloutEngine(instance.exports as unknown as Exports);
    const [n, nl] = e.put(new TextEncoder().encode(JSON.stringify(net)));
    const [r, rl] = e.put(new TextEncoder().encode(JSON.stringify(rules)));
    e.x.init(n, nl, r, rl);
    return e;
  }

  private put(bytes: Uint8Array): [number, number] {
    const p = this.x.alloc(bytes.length);
    new Uint8Array(this.x.memory.buffer, p, bytes.length).set(bytes);
    return [p, bytes.length];
  }

  /** The move to play in a 'move' phase state, with up to `nmax` playouts per candidate. */
  choose(state: GameState, nmax: number, seed: number): Move {
    if (state.moves.length === 1) return state.moves[0]!;
    const [p, l] = this.put(encodeState(state));
    const k = this.x.choose(p, l, nmax, seed >>> 0);
    const m = state.moves[k];
    if (!m) throw new Error(`rollout engine returned move ${k} of ${state.moves.length}`);
    return m;
  }

  /** How many moves the engine sees in `state` (must equal state.moves.length). */
  movesLen(state: GameState): number {
    const [p, l] = this.put(encodeState(state));
    return this.x.moves_len(p, l);
  }
}
