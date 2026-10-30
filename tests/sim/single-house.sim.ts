// Classic games, one house per person: 2, 3 and 4 players. See harness.ts.
import { newGame } from '../../src/engine';
import { runSimulation } from './harness';

runSimulation('Single house', [
  { name: '2p', seed: 2 * 31, make: () => newGame(2, []) },
  { name: '3p', seed: 3 * 31, make: () => newGame(3, []) },
  { name: '4p', seed: 4 * 31, make: () => newGame(4, []) },
]);
