// Bot levels: Normal is exactly the old bot, and every level plays legal moves through whole games.
// How strong each level is gets measured in tests/sim/bot-levels.sim.ts.
import { describe, expect, it } from 'vitest';
import { SEATS, chooseMove, createGame, move, roll, seeded, type BotLevel, type GameState } from '../src/engine';

function play(levels: BotLevel[] | undefined, seed: number, onMove?: (st: GameState) => void): GameState {
  const rng = seeded(seed);
  let st = createGame(SEATS[4].map((color, owner) => ({ color, owner, bot: true, ...(levels ? { level: levels[owner]! } : {}) })));
  for (let i = 0; i < 20000 && st.phase !== 'over'; i++) {
    if (st.phase === 'roll') st = roll(st, rng);
    else {
      onMove?.(st);
      st = move(st, chooseMove(st, rng));
    }
  }
  return st;
}

describe('bot levels', () => {
  it('Normal plays exactly like a bot with no level', () => {
    // Same game, move for move (ignoring the level field itself).
    const plain = (st: GameState) => ({ ...st, players: st.players.map(({ level: _, ...p }) => p) });
    for (const seed of [1, 2, 3]) expect(plain(play(['normal', 'normal', 'normal', 'normal'], seed))).toEqual(plain(play(undefined, seed)));
  });

  for (const level of ['easy', 'normal', 'hard'] as const) {
    it(`${level} bots finish whole games with legal moves`, () => {
      for (const seed of [11, 12]) {
        const end = play([level, level, level, level], seed, (st) => expect(st.moves).toContain(chooseMove(st, seeded(seed))));
        expect(end.phase).toBe('over');
      }
    });
  }

  it('the levels play differently', () => {
    const ends = (['easy', 'normal', 'hard'] as const).map((l) => JSON.stringify(play([l, 'normal', 'normal', 'normal'], 5).players));
    expect(new Set(ends).size).toBe(3);
  });
});
