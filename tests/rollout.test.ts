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

  // #101: the race is a prefix of the full review, so a filled race IS review(n); a settled Best is Best.
  it('races a decision: filled up to n it is review(n) exactly, settled Best it agrees, and the screen values every move', { timeout: 300_000 }, async () => {
    const e = await engine();
    expect(e.hasFast).toBe(true);
    const seen = { full: 0, best: 0, worse: 0, net: 0 };
    let raced = 0;
    for (let g = 0; g < 8 && raced < 24; g++) {
      const rng = seeded(200 + g);
      let s: GameState = createGame(SEATS[g % 2 ? 4 : 2].map((color, owner) => ({ color, owner, bot: true, level: 'hard' })));
      for (let i = 0; i < 20000 && s.phase !== 'over' && raced < 24; i++) {
        if (s.phase === 'roll') s = roll(s, rng);
        else {
          if (s.moves.length > 2 && i % 4 === 0) {
            const played = i % s.moves.length;
            const n = 64;
            const full = e.review(s, n, 9 + i);
            if (full.mean.length > 1) {
              const sc = e.reviewFast(s, 0, 0, { mode: 'screen' });
              expect(sc.kind).toBe('screen');
              expect(sc.ofMove).toEqual(full.ofMove);
              for (const x of sc.mean) expect(x >= 0 && x <= 1).toBe(true);
              const v = e.reviewFast(s, n, 9 + i, { mode: 'race', played });
              expect(v.ofMove).toEqual(full.ofMove);
              seen[v.kind as keyof typeof seen]++;
              if (v.complete) {
                expect(v.kind === 'full' || v.kind === 'worse').toBe(true);
                expect({ mean: v.mean, gap: v.gap, se: v.se, best: v.best }).toEqual({ mean: full.mean, gap: full.gap, se: full.se, best: full.best });
                expect(v.count).toEqual(full.mean.map(() => n));
              } else {
                expect(v.kind).toBe('best');
                const p = v.ofMove[played]!;
                // Settled Best: every candidate still in is under 1.5 points better than the played one.
                expect(p === v.best || 100 * v.gap[p]! < 1.5).toBe(true);
                expect(v.count!.every((k) => k <= n)).toBe(true);
                expect(v.count![p]).toBe(Math.max(...v.count!));
              }
              // The same call gives the same answer (fixed seeds), and a big skip skips.
              expect(e.reviewFast(s, n, 9 + i, { mode: 'race', played })).toEqual(v);
              expect(e.reviewFast(s, n, 9 + i, { mode: 'race', played, skip: 100 }).kind).toBe('net');
              raced++;
            }
          }
          s = move(s, chooseBotMove(s, rng));
        }
      }
    }
    expect(raced).toBe(24);
    console.log(`race outcomes over ${raced} decisions: ${JSON.stringify(seen)}`);
  });
});

