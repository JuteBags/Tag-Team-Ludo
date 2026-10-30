import { describe, expect, it } from 'vitest';
import { botStep, chooseMove, newGame, roll, seeded, type GameState } from '../src/engine';
import { B, game, prog } from './helpers';

describe('bot', () => {
  it('takes a capture when one is available', () => {
    const g = roll(game({ blue: [5, 20, -1, -1], red: [prog('red', 46), -1, -1, -1] }), seeded(3), 2);
    expect(chooseMove(g, seeded(3)).captures).toHaveLength(1);
  });

  it('runs away to a star when threatened', () => {
    const g = roll(game({ blue: [5, 30, -1, -1], red: [prog('red', 41), -1, -1, -1] }), seeded(3), 3);
    expect(chooseMove(g, seeded(3)).from).toBe(5);
  });

  for (const count of [2, 3, 4] as const) {
    it(`plays ${count}-player bot games to the end`, () => {
      const rng = seeded(100 + count);
      const games = count === 4 ? 60 : 40;
      const faces = [0, 0, 0, 0, 0, 0];
      let turns = 0;
      for (let n = 0; n < games; n++) {
        let g: GameState = newGame(count, []);
        let steps = 0;
        while (g.phase !== 'over') {
          const rolling = g.phase === 'roll';
          g = botStep(g, rng);
          if (rolling) faces[g.dice! - 1]!++;
          if (++steps > 20_000) throw new Error('game did not finish');
        }
        expect([...g.ranking].sort()).toEqual(g.players.map((p) => p.color).sort());
        turns += g.turnCount;
      }
      const total = faces.reduce((a, b) => a + b, 0);
      console.log(`${count}p: avg ${(turns / games).toFixed(0)} turns/game; face share`, faces.map((f) => ((100 * f) / total).toFixed(1) + '%').join(' '));
    }, 120_000);
  }
});

void B;
