// Extreme with its worker (#98), measured in tests with a fake worker: three seeded 4-player Extreme games
// through the app's own bot path (chooseBotMoveAsync). Every real choice goes to the worker, and the UI
// thread never imports the net (before #98 it did, at the first forced move of each session).
import { describe, expect, it, vi } from 'vitest';
import { createGame, move, roll, seeded, type GameState, type Seat } from '../src/engine';

let imported = 0;
vi.mock('../src/engine/ai/extreme-net.json', async (load) => {
  imported++;
  return load();
});

/** A fake rollout worker: answers each move request with the first move, as a real one answers with its pick. */
let asked = 0;
class FakeWorker {
  onmessage: ((e: { data: { id: number; index: number } }) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage(m: { id: number; state: GameState }) {
    asked++;
    setTimeout(() => this.onmessage?.({ data: { id: m.id, index: 0 } }), 0);
  }
  terminate() {}
}
vi.stubGlobal('Worker', FakeWorker);
const { chooseBotMoveAsync } = await import('../src/engine/ai/levels');

const SEATS: Seat[] = (['blue', 'red', 'green', 'yellow'] as const).map((color, owner) => ({ color, owner, bot: true, level: 'extreme' }));

describe('Extreme with a worker', () => {
  it('sends every real choice to the worker and never imports the net on the UI thread (3 games)', async () => {
    let forced = 0;
    let choices = 0;
    for (const seed of [1, 2, 3]) {
      const rng = seeded(seed);
      let s = createGame(SEATS, 'blue');
      for (let i = 0; i < 20000 && s.phase !== 'over'; i++) {
        if (s.phase === 'roll') s = roll(s, rng);
        else {
          if (s.moves.length === 1) forced++;
          else choices++;
          s = move(s, await chooseBotMoveAsync(s, seeded(seed * 1000 + i)));
        }
      }
      expect(s.phase).toBe('over');
    }
    console.log(`3 Extreme games: ${choices} real choices, ${forced} forced moves, worker asked ${asked} times, net imported on the UI thread ${imported} times`);
    expect(asked).toBe(choices);
    expect(imported).toBe(0);
    expect(forced).toBeGreaterThan(0);
  }, 60_000);
});
