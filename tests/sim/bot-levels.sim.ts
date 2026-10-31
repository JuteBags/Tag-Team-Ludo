// Bot levels: Blue plays Easy or Hard against Normal bots, in 2- and 4-player games. Hard has to beat
// Normal, and Normal has to beat Easy, by a clear margin. See harness.ts.
import { expect } from 'vitest';
import { SEATS, createGame, type BotLevel } from '../../src/engine';
import { runSimulation, winRate } from './harness';

const game = (players: 2 | 4, blue: BotLevel) => () =>
  createGame(SEATS[players].map((color, owner) => ({ color, owner, bot: true, level: color === 'blue' ? blue : 'normal' })));

runSimulation(
  'Bot levels (Blue vs Normal bots)',
  [
    { name: '2p Easy', seed: 701, make: game(2, 'easy') },
    { name: '2p Hard', seed: 703, make: game(2, 'hard') },
    { name: '4p Easy', seed: 707, make: game(4, 'easy') },
    { name: '4p Hard', seed: 709, make: game(4, 'hard') },
  ],
  (r) => {
    // A fair seat wins 1 in 2 games (2 players) or 1 in 4 (4 players).
    expect(winRate(r['2p Hard weighted']!)).toBeGreaterThan(0.55);
    expect(winRate(r['2p Easy weighted']!)).toBeLessThan(0.45);
    expect(winRate(r['4p Hard weighted']!)).toBeGreaterThan(0.28);
    expect(winRate(r['4p Easy weighted']!)).toBeLessThan(0.21);
  },
);
