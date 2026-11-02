// The rollout Extreme (src/engine/ai/rollout.ts): the wasm engine sees exactly the TS engine's moves, and
// it plays legal moves through whole games.
import { describe, expect, it } from 'vitest';
import { SEATS, createGame, move, roll, seeded, type GameState } from '../src/engine';
import { PLAYOUT_RULES } from '../src/engine/ai/playout-rules';
import { chooseBotMove } from '../src/engine/ai/levels';
import type { NetJSON } from '../src/engine/ai/net';
import { RolloutEngine } from '../src/engine/ai/rollout';
// @ts-expect-error: the project has no @types/node; Vitest runs on Node.
import { readFileSync } from 'node:fs';

async function engine(): Promise<RolloutEngine> {
  const wasm = readFileSync(new URL('../src/engine/ai/ludo_wasm.wasm', import.meta.url));
  const net = JSON.parse(readFileSync(new URL('../src/engine/ai/extreme-net.json', import.meta.url), 'utf8')) as NetJSON;
  return RolloutEngine.create(wasm, net, PLAYOUT_RULES);
}

describe('rollout Extreme (wasm)', () => {
  it('sees the same moves as the TS engine in every position', { timeout: 120_000 }, async () => {
    const e = await engine();
    let checked = 0;
    for (let g = 0; g < 30; g++) {
      const rng = seeded(g);
      const n = g % 2 ? 4 : 2;
      let s: GameState = createGame(SEATS[n as 2 | 4].map((color, owner) => ({ color, owner, bot: true, level: 'hard' })), undefined, g % 3 === 0);
      for (let i = 0; i < 20000 && s.phase !== 'over'; i++) {
        if (s.phase === 'roll') s = roll(s, rng);
        else {
          expect(e.movesLen(s)).toBe(s.moves.length);
          checked++;
          s = move(s, chooseBotMove(s, rng));
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('keeps its memory and its pace flat over 2000 review calls', { timeout: 300_000 }, async () => {
    const e = await engine();
    const mem = () => (e as unknown as { x: { memory: WebAssembly.Memory } }).x.memory.buffer.byteLength;
    // Decisions from a 4p game, reviewed over and over (few playouts, so the test is quick).
    const rng = seeded(11);
    let s: GameState = createGame(SEATS[4].map((color, owner) => ({ color, owner, bot: true, level: 'hard' })));
    const decisions: GameState[] = [];
    for (let i = 0; i < 20000 && s.phase !== 'over' && decisions.length < 40; i++) {
      if (s.phase === 'roll') s = roll(s, rng);
      else {
        if (s.moves.length > 1) decisions.push(s);
        s = move(s, chooseBotMove(s, rng));
      }
    }
    const time = (from: number, to: number) => {
      const t0 = performance.now();
      for (let k = from; k < to; k++) e.review(decisions[k % decisions.length]!, 4, k);
      return (performance.now() - t0) / (to - from);
    };
    const early = time(0, 200);
    const memEarly = mem();
    time(200, 1800);
    const late = time(1800, 2000);
    console.log(`review x2000: ${early.toFixed(2)} -> ${late.toFixed(2)} ms per call, memory ${memEarly} -> ${mem()} bytes`);
    expect(mem()).toBe(memEarly);
    expect(late).toBeLessThan(early * 2 + 1);
  });

  it('plays legal moves through a 4p game', { timeout: 300_000 }, async () => {
    const e = await engine();
    const rng = seeded(5);
    let s: GameState = createGame(SEATS[4].map((color, owner) => ({ color, owner, bot: true, level: 'hard' })));
    let t = 0;
    let decisions = 0;
    for (let i = 0; i < 20000 && s.phase !== 'over'; i++) {
      if (s.phase === 'roll') s = roll(s, rng);
      else if (s.current === 0 && s.moves.length > 1) {
        const t0 = performance.now();
        const m = e.choose(s, 64, i);
        t += performance.now() - t0;
        decisions++;
        expect(s.moves).toContain(m);
        s = move(s, m);
      } else s = move(s, chooseBotMove(s, rng));
    }
    expect(s.phase).toBe('over');
    console.log(`rollout wasm, nmax 64: ${decisions} decisions, ${(t / decisions).toFixed(0)} ms each`);
  });

  it('reviews a decision: every move valued, the best at zero gap, the others at or below it', { timeout: 300_000 }, async () => {
    const e = await engine();
    let reviewed = 0;
    for (let g = 0; g < 6 && reviewed < 12; g++) {
      const rng = seeded(100 + g);
      let s: GameState = createGame(SEATS[g % 2 ? 4 : 2].map((color, owner) => ({ color, owner, bot: true, level: 'hard' })));
      for (let i = 0; i < 20000 && s.phase !== 'over' && reviewed < 12; i++) {
        if (s.phase === 'roll') s = roll(s, rng);
        else {
          if (s.moves.length > 2 && i % 5 === 0) {
            const v = e.review(s, 32, 7 + i);
            expect(v.ofMove.length).toBe(s.moves.length);
            expect(v.gap[v.best]).toBe(0);
            for (let c = 0; c < v.mean.length; c++) {
              expect(v.mean[c]).toBeGreaterThanOrEqual(0);
              expect(v.mean[c]).toBeLessThanOrEqual(1);
              expect(v.gap[c]).toBeGreaterThanOrEqual(-1e-9);
              expect(v.mean[v.best]! - v.mean[c]!).toBeCloseTo(v.gap[c]!, 9);
            }
            // The same seed gives the same review.
            expect(e.review(s, 32, 7 + i)).toEqual(v);
            reviewed++;
          }
          s = move(s, chooseBotMove(s, rng));
        }
      }
    }
    expect(reviewed).toBe(12);
  });
});

