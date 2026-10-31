// One house per person with doubles off (docs/RULES.md section I): 2, 3 and 4 players. The same
// setups as single-house.sim.ts, so the two tables compare. See harness.ts.
import { newGame } from '../../src/engine';
import { runSimulation } from './harness';

runSimulation('Single house, doubles off', [
  { name: '2p', seed: 2 * 31, make: () => newGame(2, [], true) },
  { name: '3p', seed: 3 * 31, make: () => newGame(3, [], true) },
  { name: '4p', seed: 4 * 31, make: () => newGame(4, [], true) },
]);
