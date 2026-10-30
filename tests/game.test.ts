import { describe, expect, it } from 'vitest';
import { move, newGame, roll, seeded } from '../src/engine';
import { B, game, prog } from './helpers';

const rng = seeded(1);

describe('turn flow', () => {
  it('passes the turn when nothing can move', () => {
    const g = roll(newGame(4), rng, 3);
    expect(g.current).toBe(1);
    expect(g.event).toMatchObject({ type: 'no-move', dice: 3 });
  });

  it('gives another roll on a 6 even with no move', () => {
    const g = roll(game({ blue: [52, 56, 56, 56], red: B }), rng, 6);
    expect(g.current).toBe(0);
    expect(g.phase).toBe('roll');
  });

  it('cancels the third 6 in a row', () => {
    let g = newGame(4);
    g = roll(g, rng, 6);
    g = move(g, g.moves[0]!);
    g = roll(g, rng, 6);
    g = move(g, g.moves[0]!);
    expect(g.current).toBe(0);
    g = roll(g, rng, 6);
    expect(g.event).toMatchObject({ type: 'three-sixes' });
    expect(g.current).toBe(1);
  });

  it('gives another roll after a capture', () => {
    let g = roll(game({ blue: [5, -1, -1, -1], red: [prog('red', 46), -1, -1, -1] }), rng, 2);
    g = move(g, g.moves.find((m) => m.captures.length > 0)!);
    expect(g.current).toBe(0);
    expect(g.phase).toBe('roll');
  });

  it('gives another roll after finishing a token', () => {
    let g = roll(game({ blue: [55, 10, -1, -1], red: B }), rng, 1);
    g = move(g, g.moves.find((m) => m.finishes === 1)!);
    expect(g.current).toBe(0);
  });

  it('ends when one player is left and ranks them last', () => {
    let g = roll(game({ blue: [55, 56, 56, 56], red: B }), rng, 1);
    g = move(g, g.moves[0]!);
    expect(g.phase).toBe('over');
    expect(g.ranking).toEqual(['blue', 'red']);
  });

  it('rejects moves that are not legal', () => {
    const g = roll(game({ blue: [5, -1, -1, -1], red: B }), rng, 2);
    expect(() => move(g, { ...g.moves[0]!, to: 9 })).toThrow('illegal move');
  });
});
