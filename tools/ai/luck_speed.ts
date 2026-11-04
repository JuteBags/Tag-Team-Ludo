// Times the review's luck pass (#125): rollLuck + netChances, what the review worker's 'luck' call does, on
// the bench page's review games (review_speed.ts's 2p seed 101 and 4p seed 102, every seat Hard, the app's
// dice). Three ways, interleaved, `--reps` rounds each, so a busy runner weighs on all of them alike:
//   before  the net as it was before #125 (tools/ai/dense-net.ts), review.ts rollLuck + netChances
//   TS      the app's Net (#127: sparse, remembered), in chunks as the worker runs it (luck.ts netLuck): the
//           fallback where WebAssembly can't run
//   wasm    the WebAssembly engine (luck.ts wasmLuck, #125 step B), in chunks: what the worker runs
// Every luck, sd and win chance must be the same double with each: it exits 1 if not. Then the memory: the
// module's linear memory before and after the passes and its leaf cache's peak, and the JS net the wasm way
// no longer needs.
//   node tools/ai/dist/luck_speed.mjs [--reps 3]
// .github/workflows/luck-speed.yml runs it on every PR that touches the net or the luck pass.
import { appendFileSync, readFileSync } from 'node:fs';
import { createGame, move, moveEvent, replay, roll, rollEvent, SEATS, seeded, seededDie, type GameRecord, type GameState, type Seat } from '../../src/engine';
import { chooseBotMove } from '../../src/engine/ai/levels';
import { luckPass, netLuck, wasmLuck } from '../../src/engine/ai/luck';
import { Net } from '../../src/engine/ai/net';
import { decodeNet } from '../../src/engine/ai/netbin';
import { PLAYOUT_RULES } from '../../src/engine/ai/playout-rules';
import { RolloutEngine } from '../../src/engine/ai/rollout';
import { netChances, rollLuck, type RollLuck } from '../../src/engine/ai/review';
import { flags } from './common';
import { DenseNet } from './dense-net';

const a = flags(process.argv.slice(2));
const reps = Number(a.reps ?? 3);
const root = new URL('../../../', import.meta.url);
const binBytes = new Uint8Array(readFileSync(new URL('src/engine/ai/extreme-net.bin', root)));
const bin = decodeNet(binBytes);
const engine = await RolloutEngine.create(readFileSync(new URL('src/engine/ai/ludo_wasm.wasm', root)), binBytes, PLAYOUT_RULES);
if (!engine.hasLuck) throw new Error('this ludo_wasm.wasm has no luck pass: build it with wasm.yml');
const wasmBefore = engine.luckMemory.bytes;
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

type Pass = (rec: GameRecord, states: GameState[]) => { luck: RollLuck[]; chances: number[][] };
const tsNet = new Net(bin);
tsNet.remember();
const ARMS: [string, Pass][] = [
  [
    'before',
    (rec, states) => {
      const net = new DenseNet(bin);
      return { luck: rollLuck(rec, states, net), chances: netChances(rec, states, net) };
    },
  ],
  ['TS', (rec, states) => luckPass(netLuck(tsNet), rec, states)],
  ['wasm', (rec, states) => luckPass(wasmLuck(engine), rec, states)],
];

const same = (x: RollLuck[], y: RollLuck[]) => x.length === y.length && x.every((l, i) => l.at === y[i]!.at && l.face === y[i]!.face && Object.is(l.luck, y[i]!.luck) && Object.is(l.sd, y[i]!.sd));

md('### The luck pass (rollLuck + netChances), per game');
md('');
md(`Fastest of ${reps} interleaved rounds (median in brackets), ms; "same" = every luck, sd and win chance the same double as before.`);
md('');
md('| game | rolls | ' + ARMS.map(([n]) => n).join(' | ') + ' | wasm vs before | wasm vs TS | same |');
md('|---|---:|' + ARMS.map(() => '---:').join('|') + '|---:|---:|---|');
let allSame = true;
for (const [people, seed] of [[2, 101], [4, 102]] as const) {
  const rec = game(people, seed);
  const states = replay(rec).states as GameState[];
  const ms = ARMS.map(() => [] as number[]);
  let ref: { luck: RollLuck[]; chances: string } | null = null;
  let ok = true;
  for (let r = 0; r < reps; r++)
    ARMS.forEach(([, pass], k) => {
      const t = performance.now();
      const r = pass(rec, states);
      ms[k]!.push(performance.now() - t);
      const luck = r.luck;
      const chances = JSON.stringify(r.chances);
      if (!ref) ref = { luck, chances };
      else if (!same(ref.luck, luck) || ref.chances !== chances) ok = false;
    });
  allSame &&= ok;
  const min = ms.map((v) => Math.min(...v));
  const med = ms.map((v) => [...v].sort((x, y) => x - y)[Math.floor((v.length - 1) / 2)]!);
  console.log('LUCK ' + JSON.stringify({ people, seed, rolls: ref!.luck.length, ms }));
  md(`| ${people}p seed ${seed} | ${ref!.luck.length} | ` + min.map((m, k) => `${Math.round(m)} (${Math.round(med[k]!)})`).join(' | ') + ` | ${(min[0]! / min[2]!).toFixed(1)}× | ${(min[1]! / min[2]!).toFixed(1)}× | ${ok ? 'yes' : '**no**'} |`);
}
md('');
// The JS net's weights (f64) and its memo's cap: what the worker no longer holds when the module has the pass.
const weights = [...bin.trunk, bin.pool, bin.out].reduce((n, l) => n + l.W.length + l.b.length, 0) * 8;
const mem = engine.luckMemory;
console.log('MEMORY ' + JSON.stringify({ wasmBefore, wasmAfter: mem.bytes, cachePeak: mem.peak, jsNetWeights: weights }));
md('Memory:');
md(`- the module's linear memory: ${(wasmBefore / 1024).toFixed(0)} kB before the passes, ${(mem.bytes / 1024).toFixed(0)} kB after (it never shrinks); the leaf cache's peak, ${mem.peak} positions (cap 8,192), freed after each game;`);
md(`- no longer needed in the worker with the module: the JS net's weights, ${(weights / 1024).toFixed(0)} kB, and its memo (up to 1,024 trunk vectors and 1,024 scores, about 3 MB).`);
md('');
if (!allSame) {
  console.error('the luck pass changed: a value differs from the net before #125');
  process.exit(1);
}
