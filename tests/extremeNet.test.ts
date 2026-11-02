// Extreme's net on the UI thread (#98): a forced move never loads it; it loads only when Extreme has a real
// choice and no worker can run (as here: Vitest has no Worker).
import { describe, expect, it, vi } from 'vitest';
import { createGame, move, roll, seeded, type GameState, type Seat } from '../src/engine';

let imported = 0;
vi.mock('../src/engine/ai/extreme-net.json', async (load) => {
  imported++;
  return load();
});
const { chooseBotMoveAsync } = await import('../src/engine/ai/levels');

const SEATS: Seat[] = [
  { color: 'blue', owner: 0, bot: true, level: 'extreme' },
  { color: 'green', owner: 1, bot: true, level: 'extreme' },
];

/** The first Extreme decision in a seeded game with exactly `n` legal moves (1, or more than 1). */
function decision(forced: boolean): GameState {
  for (let seed = 1; seed < 200; seed++) {
    const rng = seeded(seed);
    let s = createGame(SEATS, 'blue');
    for (let i = 0; i < 2000 && s.phase !== 'over'; i++) {
      if (s.phase === 'roll') s = roll(s, rng);
      else if (forced ? s.moves.length === 1 : s.moves.length > 1) return s;
      else s = move(s, s.moves[0]!);
    }
  }
  throw new Error('no such decision');
}

describe("Extreme's net on the main thread", () => {
  it('is never loaded for a forced move', async () => {
    const s = decision(true);
    expect(await chooseBotMoveAsync(s, seeded(1))).toEqual(s.moves[0]);
    expect(imported).toBe(0);
  });

  it('is the fallback for a real choice when no worker can run', async () => {
    const s = decision(false);
    const m = await chooseBotMoveAsync(s, seeded(1));
    expect(s.moves).toContainEqual(m);
    expect(imported).toBe(1);
  });
});
