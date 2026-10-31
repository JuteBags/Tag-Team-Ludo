// One house per person, doubles on: 2, 3 and 4 players. single-house-no-doubles.sim.ts is the same
// with doubles off. See harness.ts.
import { newGame } from '../../src/engine';
import { runSimulation } from './harness';

runSimulation('Single house', [
  { name: '2p', seed: 2 * 31, make: () => newGame(2, []) },
  { name: '3p', seed: 3 * 31, make: () => newGame(3, []) },
  { name: '4p', seed: 4 * 31, make: () => newGame(4, []) },
]);
