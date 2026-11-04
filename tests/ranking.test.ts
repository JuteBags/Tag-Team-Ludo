// The places when a game ends early (#140, RULES.md rules 34 and 41): everyone not yet done ranks by tokens
// home first, then by how far the rest have got, then by fewer tokens in base, then turn order. People
// already done keep their finishing order.
import { describe, expect, it } from 'vitest';
import { createGame, finalRanking, ownerRanking, type Color, type GameState, type Seat } from '../src/engine';

const FOUR: Seat[] = (['blue', 'green', 'red', 'yellow'] as const).map((color, owner) => ({ color, owner, bot: owner > 0 }));
/** A game stopped here: these tokens, these colours already done (in that order). */
function stopped(seats: Seat[], tokens: Partial<Record<Color, number[]>>, done: Color[] = []): GameState {
  const g = createGame(seats, 'blue');
  return { ...g, players: g.players.map((p) => ({ ...p, tokens: [...(tokens[p.color] ?? [-1, -1, -1, -1])] })), ranking: [...done] };
}
const H = 56;

describe('ranking a game stopped early (#140)', () => {
  it('puts more tokens home first: 3 home and 1 in base beats 2 home and two near home', () => {
    // A (green): 3 home + 1 in base, total progress 168. B (red): 2 home + two on 50, total 212.
    const s = stopped(FOUR, { blue: [H, H, H, H], green: [H, H, H, -1], red: [H, H, 50, 50], yellow: [10, -1, -1, -1] }, ['blue']);
    expect(ownerRanking(s)).toEqual([0, 1, 2, 3]);
    expect(finalRanking(s)).toEqual(['blue', 'green', 'red', 'yellow']);
  });

  it('breaks a tie on tokens home by how far the rest have got', () => {
    const s = stopped(FOUR, { blue: [H, H, H, H], green: [H, 10, 5, -1], red: [H, 40, 30, -1], yellow: [H, -1, -1, -1] }, ['blue']);
    // green and red: 1 home each; red's rest 70 against green's 15; yellow 1 home, nothing out.
    expect(ownerRanking(s)).toEqual([0, 2, 1, 3]);
    expect(finalRanking(s)).toEqual(['blue', 'red', 'green', 'yellow']);
  });

  it('then by fewer tokens still in base, then turn order', () => {
    // green and red: no token home, the same progress (30); green has 2 in base, red 1. yellow ties red fully.
    const s = stopped(FOUR, { blue: [H, H, H, H], green: [20, 10, -1, -1], red: [10, 10, 10, -1], yellow: [10, 10, 10, -1] }, ['blue']);
    expect(ownerRanking(s)).toEqual([0, 2, 3, 1]);
    expect(finalRanking(s)).toEqual(['blue', 'red', 'yellow', 'green']);
  });

  it('counts both houses of a person with two', () => {
    // Owner 0 has blue and red; owner 1 green and yellow. Owner 0: 3 home across both, little progress;
    // owner 1: 2 home, a lot of progress. Tokens home decide.
    const teams: Seat[] = (['blue', 'green', 'red', 'yellow'] as const).map((color) => ({ color, owner: color === 'blue' || color === 'red' ? 0 : 1, bot: false }));
    const s = stopped(teams, { blue: [H, H, 2, -1], red: [H, -1, -1, -1], green: [H, 50, 50, 50], yellow: [H, 50, 50, 50] });
    expect(ownerRanking(s)).toEqual([0, 1]);
  });

  it('keeps people already done in their finishing order, ahead of everyone else', () => {
    // yellow finished first, then green; blue and red not done (red has more home).
    const s = stopped(FOUR, { blue: [H, 50, 50, 50], green: [H, H, H, H], red: [H, H, -1, -1], yellow: [H, H, H, H] }, ['yellow', 'green']);
    expect(ownerRanking(s)).toEqual([3, 1, 2, 0]);
    expect(finalRanking(s)).toEqual(['yellow', 'green', 'red', 'blue']);
  });
});
