// Players who own two houses (2-player games): their colours are one side. See docs/RULES.md section H.
import { describe, expect, it } from 'vitest';
import { createGame, isThreatened, legalMoves, move, ownerRanking, roll, seeded, type GameState, type PlayerState } from '../src/engine';
import { B, prog } from './helpers';

const rng = seeded(3);

/** Blue and Red belong to person 0, Green and Yellow to person 1. */
function teams(tokens: Partial<Record<'blue' | 'green' | 'red' | 'yellow', number[]>>): PlayerState[] {
  return createGame([
    { color: 'blue', owner: 0, bot: false },
    { color: 'green', owner: 1, bot: false },
    { color: 'red', owner: 0, bot: false },
    { color: 'yellow', owner: 1, bot: false },
  ]).players.map((p) => ({ ...p, tokens: [...(tokens[p.color] ?? B)] }));
}

const withPlayers = (players: PlayerState[]): GameState => ({ ...createGame(players.map(({ color, owner, bot }) => ({ color, owner, bot }))), players });

describe('setting up a game', () => {
  it('keeps turn order clockwise and starts with the chosen colour', () => {
    const g = createGame([{ color: 'red', owner: 0, bot: false }, { color: 'blue', owner: 1, bot: true }], 'red');
    expect(g.players.map((p) => p.color)).toEqual(['blue', 'red']);
    expect(g.players[g.current]!.color).toBe('red');
    expect(g.players.map((p) => p.owner)).toEqual([1, 0]);
  });

  it('gives every colour its own owner in a classic game', async () => {
    const { newGame } = await import('../src/engine');
    expect(newGame(4).players.map((p) => p.owner)).toEqual([0, 1, 2, 3]);
  });
});

describe('two houses on one side', () => {
  it('never captures a teammate', () => {
    // Blue at 5 rolls 2 onto Red's single (square 46).
    const ps = teams({ blue: [5, -1, -1, -1], red: [prog('red', 46), -1, -1, -1] });
    expect(legalMoves(ps, 'blue', 2)[0]!.captures).toEqual([]);
  });

  it('still captures the other side', () => {
    const ps = teams({ blue: [5, -1, -1, -1], green: [prog('green', 46), -1, -1, -1] });
    expect(legalMoves(ps, 'blue', 2)[0]!.captures).toEqual([{ color: 'green', token: 0 }]);
  });

  it("lets a single pass its teammate's double", () => {
    const ps = teams({ blue: [7, -1, -1, -1], red: [prog('red', 49), prog('red', 49), -1, -1] });
    expect(legalMoves(ps, 'blue', 4)).toHaveLength(1);
  });

  it("doesn't kill a teammate's double with a double", () => {
    const ps = teams({ blue: [10, 10, -1, -1], red: [prog('red', 51), prog('red', 51), -1, -1] });
    expect(legalMoves(ps, 'blue', 4)[0]!.captures).toEqual([]);
  });

  it('sees no threat from a teammate', () => {
    const ps = teams({ blue: [5, -1, -1, -1], red: [prog('red', 41), -1, -1, -1] });
    expect(isThreatened(ps, 'blue', 5)).toBe(false);
  });
});

describe('finishing with two houses', () => {
  it('keeps playing while a person still has one house to bring home', () => {
    let g = roll(withPlayers(teams({ blue: [55, 56, 56, 56], red: [10, -1, -1, -1], green: [3, -1, -1, -1] })), rng, 1);
    g = move(g, g.moves[0]!);
    expect(g.phase).not.toBe('over');
  });

  it('ends when only one person still has tokens out, and ranks people', () => {
    let g = roll(withPlayers(teams({ blue: [55, 56, 56, 56], red: [56, 56, 56, 56], green: [3, -1, -1, -1] })), rng, 1);
    g = move(g, g.moves[0]!);
    expect(g.phase).toBe('over');
    expect(ownerRanking(g)).toEqual([0, 1]);
  });
});
