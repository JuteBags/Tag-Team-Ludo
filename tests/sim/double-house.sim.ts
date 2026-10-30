// 2-player games where each person has two houses: opposite each other, and side by side. Person 0 plays
// Blue and its partner, person 1 the other two. See harness.ts.
import { createGame, type Color } from '../../src/engine';
import { runSimulation } from './harness';

const twoHouses = (mine: Color[]) => () =>
  createGame((['blue', 'green', 'red', 'yellow'] as const).map((color) => ({ color, owner: mine.includes(color) ? 0 : 1, bot: true })));

runSimulation('Double house', [
  { name: '2p·2h opposite', seed: 1001, make: twoHouses(['blue', 'red']) },
  { name: '2p·2h side by side', seed: 1003, make: twoHouses(['blue', 'green']) },
]);
