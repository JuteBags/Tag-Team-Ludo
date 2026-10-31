// 2-player games with two houses each and doubles off (docs/RULES.md section I): opposite each other,
// and side by side. The same setups as double-house.sim.ts, so the two tables compare. See harness.ts.
import { createGame, type Color } from '../../src/engine';
import { runSimulation } from './harness';

const twoHouses = (mine: Color[]) => () =>
  createGame((['blue', 'green', 'red', 'yellow'] as const).map((color) => ({ color, owner: mine.includes(color) ? 0 : 1, bot: true })), undefined, true);

runSimulation('Double house, doubles off', [
  { name: '2p·2h opposite', seed: 1001, make: twoHouses(['blue', 'red']) },
  { name: '2p·2h side by side', seed: 1003, make: twoHouses(['blue', 'green']) },
]);
