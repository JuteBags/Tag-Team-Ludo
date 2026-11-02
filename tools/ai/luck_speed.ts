// Times the review's luck pass (#125): rollLuck + netChances, what the review worker's 'luck' call does, on
// the bench page's review games (review_speed.ts's 2p seed 101 and 4p seed 102, every seat Hard, the app's
// dice). Three nets, interleaved, `--reps` rounds each, so a busy runner weighs on all of them alike:
//   before         the net as it was before #125 (tools/ai/dense-net.ts)
//   sparse         the app's Net: the first layer reads only a colour's non-zero inputs
//   sparse + memo  the app's Net as the worker uses it (remember(), forget() per game)
// Every luck, sd and win chance must be the same double with each: it exits 1 if not.
//   node tools/ai/dist/luck_speed.mjs [--reps 3]
// .github/workflows/luck-speed.yml runs it on every PR that touches the net or the luck pass.
import { appendFileSync, readFileSync } from 'node:fs';
import { createGame, move, moveEvent, replay, roll, rollEvent, SEATS, seeded, seededDie, type GameRecord, type GameState, type Seat } from '../../src/engine';
import { chooseBotMove } from '../../src/engine/ai/levels';
import type { Evaluator } from '../../src/engine/ai/linear';
import { Net } from '../../src/engine/ai/net';
import { decodeNet } from '../../src/engine/ai/netbin';
import { netChances, rollLuck, type RollLuck } from '../../src/engine/ai/review';
import { flags } from './common';
import { DenseNet } from './dense-net';

const a = flags(process.argv.slice(2));
const reps = Number(a.reps ?? 3);
const root = new URL('../../../', import.meta.url);
const bin = decodeNet(new Uint8Array(readFileSync(new URL('src/engine/ai/extreme-net.bin', root))));
const summary = process.env.GITHUB_STEP_SUMMARY;
const md = (line: string) => {
  console.log(line);
  if (summary) appendFileSync(summary, line + '\n');
};

/** review_speed.ts's game: every seat Hard (seat 0 the mover), the app's dice, doubles on. */
function game(people: 2 | 4, seed: number): GameRecord {
  const seats: Seat[] = SEATS[people].map((color, owner) => ({ color, owner, bot: true, level: 'hard' }));
  const rng = seeded(seed * 31 + 7);
  let s = createGame(seats, seats[seed % people]!.color, false);
  let events = '';
  for (let k = 0; s.phase !== 'over' && k < 20000; k++) {
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
  return { v: 1, seats, first: seats[seed % people]!.color, seed, events };
}

const ARMS: [string, () => Evaluator & { forget?: () => void }][] = [
  ['before', () => new DenseNet(bin)],
  ['sparse', () => new Net(bin)],
  [
    'sparse + memo',
    () => {
      const n = new Net(bin);
      n.remember();
      return n;
    },
  ],
];

const same = (x: RollLuck[], y: RollLuck[]) => x.length === y.length && x.every((l, i) => l.at === y[i]!.at && l.face === y[i]!.face && Object.is(l.luck, y[i]!.luck) && Object.is(l.sd, y[i]!.sd));

md('### The luck pass (rollLuck + netChances), per game');
md('');
md(`Fastest of ${reps} interleaved rounds (median in brackets), ms; "same" = every luck, sd and win chance the same double as before.`);
md('');
md('| game | rolls | ' + ARMS.map(([n]) => n).join(' | ') + ' | speed-up | same |');
md('|---|---:|' + ARMS.map(() => '---:').join('|') + '|---:|---|');
let allSame = true;
for (const [people, seed] of [[2, 101], [4, 102]] as const) {
  const rec = game(people, seed);
  const states = replay(rec).states as GameState[];
  const ms = ARMS.map(() => [] as number[]);
  let ref: { luck: RollLuck[]; chances: string } | null = null;
  let ok = true;
  for (let r = 0; r < reps; r++)
    ARMS.forEach(([, make], k) => {
      const net = make();
      const t = performance.now();
      const luck = rollLuck(rec, states, net);
      const chances = JSON.stringify(netChances(rec, states, net));
      ms[k]!.push(performance.now() - t);
      if (!ref) ref = { luck, chances };
      else if (!same(ref.luck, luck) || ref.chances !== chances) ok = false;
    });
  allSame &&= ok;
  const min = ms.map((v) => Math.min(...v));
  const med = ms.map((v) => [...v].sort((x, y) => x - y)[Math.floor((v.length - 1) / 2)]!);
  console.log('LUCK ' + JSON.stringify({ people, seed, rolls: ref!.luck.length, ms }));
  md(`| ${people}p seed ${seed} | ${ref!.luck.length} | ` + min.map((m, k) => `${Math.round(m)} (${Math.round(med[k]!)})`).join(' | ') + ` | ${(min[0]! / min.at(-1)!).toFixed(2)}× | ${ok ? 'yes' : '**no**'} |`);
}
md('');
if (!allSame) {
  console.error('the luck pass changed: a value differs from the net before #125');
  process.exit(1);
}
