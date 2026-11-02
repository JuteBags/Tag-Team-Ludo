// The rollout Extreme: sim-rs's adaptive rollout player (rollout.rs choose_race) compiled to WebAssembly
// (sim-wasm/ on feat/rollout-app; ludo_wasm.wasm). At each decision every distinct move is played out
// many times on shared dice (Hard's rules play every seat for 12 turns, then the Extreme net scores the
// position); clearly worse moves stop early, close calls get up to `nmax` playouts each, and Hard's own
// move is left only for a significant paired gain.
import { COLORS } from '../board';
import type { GameState, Move } from '../types';
import type { LinearJSON } from './linear';
import type { NetJSON } from './net';
import type { DecisionValues } from './review';

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  init(net: number, netLen: number, rules: number, rulesLen: number): number;
  choose(state: number, len: number, nmax: number, seed: number): number;
  moves_len(state: number, len: number): number;
  /** The game review's values for one decision (sim-wasm review); missing in modules built before #65. */
  review?(state: number, len: number, n: number, seed: number): number;
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

  /**
   * The game review's values for one decision (#65): `n` paired playouts for every distinct move, no early
   * stop (sim-rs rollout.rs review). Indexes are into state.moves.
   */
  review(state: GameState, n: number, seed: number): DecisionValues {
    if (!this.x.review) throw new Error('this rollout engine has no review');
    const [p, l] = this.put(encodeState(state));
    const at = this.x.review(p, l, n, seed >>> 0);
    if (!at) throw new Error('rollout engine not initialised');
    const head = new Float64Array(this.x.memory.buffer, at, 3);
    const [nm, nc, best] = [head[0]!, head[1]!, head[2]!];
    const all = new Float64Array(this.x.memory.buffer, at, 3 + nm + 3 * nc);
    const ofMove = Array.from(all.subarray(3, 3 + nm));
    const per = all.subarray(3 + nm);
    const pick = (k: number) => Array.from({ length: nc }, (_, c) => per[3 * c + k]!);
    if (ofMove.length !== state.moves.length) throw new Error(`review saw ${ofMove.length} moves, the game has ${state.moves.length}`);
    return { ofMove, mean: pick(0), gap: pick(1), se: pick(2), best };
  }

  /** How many moves the engine sees in `state` (must equal state.moves.length). */
  movesLen(state: GameState): number {
    const [p, l] = this.put(encodeState(state));
    return this.x.moves_len(p, l);
  }
}
