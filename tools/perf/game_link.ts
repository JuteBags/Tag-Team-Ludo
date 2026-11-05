// A game link for the perf screens (#98): a seeded game, every seat played by Hard with the app's dice, saved
// with seat 0 as the person, as the share link's payload (deflated JSON, base64url: record.ts encodeRecord).
//   npx rolldown tools/perf/game_link.ts --platform node --format esm --file tools/perf/dist/game_link.mjs
//   node tools/perf/dist/game_link.mjs --players 4 --seed 24 > tools/perf/game-4p-seed24.link.txt
import { deflateRawSync } from 'node:zlib';
import { createGame, move, roll, seeded, type Color, type GameRecord, type GameState, type Seat } from '../../src/engine';
import { chooseBotMove } from '../../src/engine/ai/levels';
import { moveEvent, rollEvent, seededDie } from '../../src/engine/record';

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1]! : d;
};
const players = Number(arg('players', '4'));
const seed = Number(arg('seed', '24'));
const colors: Color[] = players === 2 ? ['blue', 'red'] : players === 3 ? ['blue', 'green', 'red'] : ['blue', 'green', 'red', 'yellow'];
const play: Seat[] = colors.map((color, owner) => ({ color, owner, bot: true, level: 'hard' }));
const rng = seeded(seed);
let s: GameState = createGame(play, 'blue');
let events = '';
for (let n = 0; s.phase !== 'over' && n < 20000; n++) {
  if (s.phase === 'roll') {
    const f = seededDie(seed, s);
    events += rollEvent(f);
    s = roll(s, () => 0, f);
  } else {
    const m = chooseBotMove(s, rng);
    events += moveEvent(m);
    s = move(s, m);
  }
}
if (s.phase !== 'over') throw new Error('the game did not end');
const seats: Seat[] = play.map((x) => (x.owner === 0 ? { color: x.color, owner: 0, bot: false } : x));
const rec: GameRecord = { v: 1, seats, first: 'blue', seed, events };
process.stdout.write(deflateRawSync(Buffer.from(JSON.stringify(rec))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '\n');
