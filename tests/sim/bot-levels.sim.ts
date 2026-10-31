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
    // A fair seat wins 1 in 2 games (2 players) or 1 in 4 (4 players). With SIM_PART each process
    // checks the setups it ran.
    const check = (k: string, f: (rate: number) => void) => r[k] && f(winRate(r[k]));
    check('2p Hard weighted', (w) => expect(w).toBeGreaterThan(0.55));
    check('2p Easy weighted', (w) => expect(w).toBeLessThan(0.45));
    check('4p Hard weighted', (w) => expect(w).toBeGreaterThan(0.28));
    check('4p Easy weighted', (w) => expect(w).toBeLessThan(0.21));
  },
);
