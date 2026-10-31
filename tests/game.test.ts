import { describe, expect, it } from 'vitest';
import { move, newGame, roll, seeded, squareOf } from '../src/engine';
import { B, game, prog } from './helpers';

const rng = seeded(1);

describe('turn flow', () => {
  it('passes the turn when nothing can move', () => {
    const g = roll(newGame(4), rng, 3);
    expect(g.current).toBe(1);
    expect(g.event).toMatchObject({ type: 'no-move', dice: 3 });
  });

  it('rolls again on a 6 before anything moves, even with no move', () => {
    const g = roll(game({ blue: [52, 56, 56, 56], red: B }), rng, 6);
    expect(g.current).toBe(0);
    expect(g.phase).toBe('roll');
    expect(g.rolls).toEqual([6]);
    expect(g.moves).toEqual([]);
  });

  it('rolls the whole turn into the tray, then plays it in any order', () => {
    let g = newGame(4);
    for (const f of [6, 6, 4]) g = roll(g, rng, f);
    expect(g.phase).toBe('move');
    expect(g.rolls).toEqual([6, 6, 4]);
    // Every token is at home: only a 6 can be used, to bring one out.
    expect(new Set(g.moves.map((m) => m.roll))).toEqual(new Set([6]));
    g = move(g, g.moves.find((m) => m.kind === 'release')!);
    expect(g.rolls).toEqual([6, 4]);
    // Now the 4 can move the token that came out, before the other 6 is used.
    g = move(g, g.moves.find((m) => m.roll === 4)!);
    expect(g.players[0]!.tokens).toContain(4);
    expect(g.rolls).toEqual([6]);
    g = move(g, g.moves.find((m) => m.kind === 'release')!);
    expect(g.current).toBe(1);
    expect(g.rolls).toEqual([]);
  });

  it('cancels the whole turn on a third 6 in a row: nothing has moved', () => {
    let g = newGame(4);
    for (const f of [6, 6, 6]) g = roll(g, rng, f);
    expect(g.event).toMatchObject({ type: 'three-sixes' });
    expect(g.current).toBe(1);
    expect(g.rolls).toEqual([]);
    expect(g.players[0]!.tokens).toEqual(B);
  });

  it('rolls again right after a capture, keeping the rest of the tray', () => {
    let g = game({ blue: [5, -1, -1, -1], red: [prog('red', 46), -1, -1, -1] });
    g = roll(roll(g, rng, 6), rng, 2);
    expect(g.rolls).toEqual([6, 2]);
    g = move(g, g.moves.find((m) => m.captures.length > 0)!);
    expect(g.current).toBe(0);
    expect(g.phase).toBe('roll');
    expect(g.rolls).toEqual([6]);
    g = roll(g, rng, 3);
    expect(g.phase).toBe('move');
    expect(g.rolls).toEqual([6, 3]);
  });

  // 6, 6, 4: kill with the 4, and the extra roll is a 6. The tray holds three 6s, but not three in a
  // row (6, 6, 4, then 6), so nothing is cancelled and that 6 rolls again.
  it('does not cancel three 6s in the tray that were not rolled in a row', () => {
    let g = game({ blue: [10, -1, -1, -1], red: [prog('red', squareOf('blue', 14)!), -1, -1, -1] });
    for (const f of [6, 6, 4]) g = roll(g, rng, f);
    g = move(g, g.moves.find((m) => m.roll === 4 && m.captures.length)!);
    expect(g.phase).toBe('roll');
    g = roll(g, rng, 6);
    expect(g.rolls).toEqual([6, 6, 6]);
    expect(g.phase).toBe('roll');
    expect(g.current).toBe(0);
    g = roll(g, rng, 2);
    expect(g.phase).toBe('move');
    expect(g.rolls).toEqual([6, 6, 6, 2]);
  });

  // 6, 6, 4: kill with the 4, then 6, 6, 6. Only those three 6s are cancelled: the two 6s kept from
  // before the kill stay in the tray and are still played.
  it('cancels only the three 6s in a row after a kill, and keeps the dice from before it', () => {
    let g = game({ blue: [10, -1, -1, -1], red: [prog('red', squareOf('blue', 14)!), -1, -1, -1] });
    for (const f of [6, 6, 4]) g = roll(g, rng, f);
    g = move(g, g.moves.find((m) => m.roll === 4 && m.captures.length)!);
    for (const f of [6, 6, 6]) g = roll(g, rng, f);
    expect(g.event).toMatchObject({ type: 'three-sixes' });
    expect(g.current).toBe(0);
    expect(g.phase).toBe('move');
    expect(g.rolls).toEqual([6, 6]);
    expect(g.players[0]!.tokens[0]).toBe(14);
    expect(g.players[1]!.tokens[0]).toBe(-1);
  });

  it('passes the turn on three 6s after a kill when nothing is kept', () => {
    let g = game({ blue: [10, -1, -1, -1], red: [prog('red', squareOf('blue', 14)!), -1, -1, -1] });
    g = roll(g, rng, 4);
    g = move(g, g.moves.find((m) => m.captures.length)!);
    for (const f of [6, 6, 6]) g = roll(g, rng, f);
    expect(g.event).toMatchObject({ type: 'three-sixes' });
    expect(g.current).toBe(1);
    expect(g.rolls).toEqual([]);
  });

  // A kill with a 6 earns two more dice: the 6's own roll again (rolled before moving) and the kill's.
  it('gives a kill with a 6 two more rolls', () => {
    let g = game({ blue: [10, -1, -1, -1], red: [prog('red', squareOf('blue', 16)!), -1, -1, -1] });
    g = roll(roll(g, rng, 6), rng, 3);
    expect(g.rolls).toEqual([6, 3]);
    g = move(g, g.moves.find((m) => m.roll === 6 && m.captures.length)!);
    expect(g.phase).toBe('roll');
    g = roll(g, rng, 5);
    expect(g.rolls).toEqual([3, 5]);
  });

  it('loses the dice nothing can use, and passes the turn', () => {
    let g = game({ blue: [52, 56, 56, 56], red: B });
    g = roll(roll(g, rng, 6), rng, 2);
    g = move(g, g.moves[0]!);
    expect(g.current).toBe(1);
    expect(g.event).toMatchObject({ type: 'moved', lost: [6] });
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
