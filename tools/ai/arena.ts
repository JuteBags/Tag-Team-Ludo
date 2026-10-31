// Arena: policy A against policy B on paired seeds, so luck cancels as far as it can.
//   node arena.mjs --a net:w.json:2 --b hard --mode 2p --from 0 --to 5000
// Each seed is played once per seat A can take (A as each person in turn, B as everyone else), with
// the same dice stream. Prints ARENA {...} with A's games, wins and summed places, plus per seed the
// sum of squared wins (seedSq), so the error bar can be taken over seeds: the paired outcomes.
import { ownerRanking, seeded } from '../../src/engine';
import { flags, peopleIn, playGame, policy } from './common';

const a = flags(process.argv.slice(2));
const A = policy(a.a!);
const B = policy(a.b!);
const mode = a.mode ?? '2p';
const people = peopleIn(mode);
let games = 0;
let wins = 0;
let placeSum = 0;
let seeds = 0;
let seedSq = 0;
const t0 = Date.now();
for (let seed = Number(a.from ?? 0); seed < Number(a.to ?? 1000); seed++) {
  let seedWins = 0;
  for (let seat = 0; seat < people; seat++) {
    const rng = seeded(seed * 7919 + 13);
    const end = playGame(mode, Array.from({ length: people }, (_, o) => (o === seat ? A : B)), rng, seed % 4);
    const place = ownerRanking(end).indexOf(seat) + 1;
    games++;
    if (place === 1) seedWins++;
    placeSum += place;
  }
  wins += seedWins;
  seeds++;
  seedSq += seedWins * seedWins;
}
console.log(`ARENA ${JSON.stringify({ a: a.a, b: a.b, mode, people, games, wins, placeSum, seeds, seedSq, ms: Date.now() - t0 })}`);
