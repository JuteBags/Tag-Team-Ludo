// The rollout Extreme (src/engine/ai/rollout.ts): the wasm engine sees exactly the TS engine's moves, and
// it plays legal moves through whole games.
import { describe, expect, it } from 'vitest';
import { SEATS, createGame, move, roll, seeded, type GameState } from '../src/engine';
import { HARD_RULES } from '../src/engine/ai/hard-rules';
import { chooseBotMove } from '../src/engine/ai/levels';
import type { NetJSON } from '../src/engine/ai/net';
import { RolloutEngine } from '../src/engine/ai/rollout';
// @ts-expect-error: the project has no @types/node; Vitest runs on Node.
import { readFileSync } from 'node:fs';

async function engine(): Promise<RolloutEngine> {
  const wasm = readFileSync(new URL('../src/engine/ai/ludo_wasm.wasm', import.meta.url));
  const net = JSON.parse(readFileSync(new URL('../src/engine/ai/extreme-net.json', import.meta.url), 'utf8')) as NetJSON;
  return RolloutEngine.create(wasm, net, HARD_RULES);
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
});
