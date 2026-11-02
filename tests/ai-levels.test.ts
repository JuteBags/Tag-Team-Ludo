// App bot levels (src/engine/ai/levels.ts): Hard plans whole turns with readable rules, Extreme with the net.
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error: the project has no @types/node; Vitest runs on Node.
import { readFileSync } from 'node:fs';
import { SEATS, createGame, move, roll, seeded, type BotLevel, type GameState } from '../src/engine';
import { chooseBotMove, loadExtreme } from '../src/engine/ai/levels';

// loadExtreme() fetches extreme-net.bin (#98); Node's fetch can't read files, so serve it from disk.
const netBytes = readFileSync(new URL('../src/engine/ai/extreme-net.bin', import.meta.url));
vi.stubGlobal('fetch', async () => new Response(netBytes));

function play(levels: BotLevel[], seed: number): GameState {
  const rng = seeded(seed);
  let s = createGame(SEATS[levels.length as 2 | 4].map((color, owner) => ({ color, owner, bot: true, level: levels[owner]! })));
  for (let i = 0; i < 20000 && s.phase !== 'over'; i++) {
    if (s.phase === 'roll') s = roll(s, rng);
    else {
      const m = chooseBotMove(s, rng);
      expect(s.moves).toContain(m);
      s = move(s, m);
    }
  }
  return s;
}

describe('bot levels', () => {
  it('Hard and Extreme always play legal moves and finish games', { timeout: 60_000 }, async () => {
    await loadExtreme();
    for (let g = 0; g < 4; g++) expect(play(['hard', 'extreme'], g).phase).toBe('over');
    expect(play(['extreme', 'hard', 'normal', 'easy'], 9).phase).toBe('over');
  });

  it('Extreme plays its own moves once its net is loaded', { timeout: 60_000 }, async () => {
    await loadExtreme();
    // Over a handful of seeded games the net and the rules disagree somewhere.
    const a = play(['extreme', 'normal'], 3);
    const b = play(['hard', 'normal'], 3);
    expect(a.ranking.join() + a.turnCount).not.toBe(b.ranking.join() + b.turnCount);
  });
});
