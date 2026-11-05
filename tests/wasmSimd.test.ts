// The two engine builds (#151): the SIMD module (sim-wasm built with +simd128) gives the very same doubles as the
// plain one for the Extreme bot, the review and the luck pass, and the app picks it only where SIMD validates.
import { describe, expect, it } from 'vitest';
// @ts-expect-error: the project has no @types/node; Vitest runs on Node.
import { readFileSync } from 'node:fs';
import { createGame, move, roll, seeded, seededDie, type GameState, type Seat } from '../src/engine';
import { chooseBotMove } from '../src/engine/ai/levels';
import { PLAYOUT_RULES } from '../src/engine/ai/playout-rules';
import { isJudgedRoll } from '../src/engine/ai/review';
import { RolloutEngine } from '../src/engine/ai/rollout';
import { FORCE_PLAIN, resetWasmKind, wasmKind } from '../src/engine/ai/wasmModule';

const bytes = (f: string) => new Uint8Array(readFileSync(new URL(`../src/engine/ai/${f}`, import.meta.url)));
const net = bytes('extreme-net.bin');
const engines = async () => [await RolloutEngine.create(bytes('ludo_wasm.wasm'), net, PLAYOUT_RULES), await RolloutEngine.create(bytes('ludo_wasm_simd.wasm'), net, PLAYOUT_RULES)];

/** A 4p game's states (every seat Hard, the app's dice). */
function states(seed: number): GameState[] {
  const seats: Seat[] = (['blue', 'green', 'red', 'yellow'] as const).map((color, owner) => ({ color, owner, bot: true, level: 'hard' }));
  const rng = seeded(seed);
  let s = createGame(seats, 'blue');
  const out = [s];
  for (let k = 0; s.phase !== 'over' && k < 3000; k++) {
    s = s.phase === 'roll' ? roll(s, () => 0, seededDie(seed, s)) : move(s, chooseBotMove(s, rng));
    out.push(s);
  }
  return out;
}

const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => Object.is(x, b[i]));

describe('the SIMD engine build (#151)', () => {
  it('gives every review value and every move bit for bit as the plain build', async () => {
    const [plain, simd] = await engines();
    const decisions = states(102).filter((s) => s.phase === 'move' && s.moves.length > 1).slice(0, 25);
    for (const [i, s] of decisions.entries()) {
      const a = plain!.review(s, 32, 11 + i);
      const b = simd!.review(s, 32, 11 + i);
      const flat = (v: typeof a) => [...v.mean, ...v.gap, ...v.se, v.best, ...v.ofMove];
      if (!same(flat(a), flat(b))) expect.fail(`decision ${i}: ${flat(a)} vs ${flat(b)}`);
      expect(simd!.choose(s, 64, 5 + i)).toEqual(plain!.choose(s, 64, 5 + i));
    }
  }, 300_000);

  it("gives every position value (#194) bit for bit as the plain build, and the review's mean for a candidate", async () => {
    const [plain, simd] = await engines();
    const all = states(103);
    for (const [i, s] of all.filter((_, k) => k % 37 === 0).slice(0, 25).entries()) {
      const owner = s.players[s.current]!.owner;
      expect(Object.is(simd!.value(s, 32, 7 + i, owner), plain!.value(s, 32, 7 + i, owner))).toBe(true);
    }
    // A candidate's value in the review is the same playouts from its position: value() gives it exactly.
    const d = all.find((s) => s.phase === 'move' && new Set(s.moves.map((m) => JSON.stringify(move(s, m).players.map((p) => p.tokens)))).size === s.moves.length && s.moves.length >= 2)!;
    const r = plain!.review(d, 64, 21);
    for (const [k, m] of d.moves.entries()) {
      const c = r.ofMove[k]!;
      expect(Object.is(plain!.value(move(d, m), 64, 21, d.players[d.current]!.owner), r.mean[c])).toBe(true);
    }
  }, 300_000);

  it('gives every luck value bit for bit as the plain build', async () => {
    const [plain, simd] = await engines();
    const all = states(13);
    const rolls = all.filter((_, i) => isJudgedRoll(all, i)).slice(0, 200);
    for (const e of [plain!, simd!]) e.luckBegin();
    try {
      expect(same(Array.from(simd!.luckChunk(rolls, 0)), Array.from(plain!.luckChunk(rolls, 0)))).toBe(true);
      expect(same(Array.from(simd!.luckChunk(all.slice(0, 300), 1)), Array.from(plain!.luckChunk(all.slice(0, 300), 1)))).toBe(true);
    } finally {
      for (const e of [plain!, simd!]) e.luckEnd();
    }
  }, 300_000);

  it('is picked only where SIMD validates, and a worker named wasm=plain keeps the plain build', () => {
    resetWasmKind();
    expect(wasmKind(() => false)).toBe('plain');
    resetWasmKind();
    expect(wasmKind(() => {
      throw new Error('no WebAssembly');
    })).toBe('plain');
    resetWasmKind();
    expect(wasmKind(() => true)).toBe('simd');
    resetWasmKind();
    expect(wasmKind()).toBe('simd'); // Node has WebAssembly SIMD: the real probe validates
    const g = globalThis as { name?: unknown };
    const before = g.name;
    g.name = FORCE_PLAIN;
    resetWasmKind();
    expect(wasmKind(() => true)).toBe('plain');
    g.name = before;
    resetWasmKind();
  });
});
