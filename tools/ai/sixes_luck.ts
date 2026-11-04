// #135: is a run of sixes valued right in the review's luck? Two measurements, on crafted positions:
//  1. The luck of each roll of 6 -> 6 -> 6 (the third 6 cancels the run: RULES.md rule 13), computed exactly
//     as the app does (review.ts faceValues with the shipped net, fair dice: a crafted position has no game
//     seed), and their sum. Expected: the first 6 lucky, the third strongly unlucky, the sum negative.
//  2. The net's value of the roller at sixes 0, 1 and 2 (tray [], [6], [6, 6]) against a playout value: the
//     fair expectation over the next face of the best move's value by the full review (sim-rs rollout.rs
//     review, `--n` paired playouts per move), through any 6 that rolls again and any turn that passes (2p:
//     the roller's chance is 1 - the opponent's). Two seeds, to show the noise.
//   node tools/ai/dist/sixes_luck.mjs [--n 1024]
// .github/workflows/review-study.yml runs it (heavy: never on the laptop).
import { appendFileSync, readFileSync } from 'node:fs';
import { createGame, move, ownerRanking, roll, type Color, type GameState, type Seat } from '../../src/engine';
import { Net } from '../../src/engine/ai/net';
import { decodeNet } from '../../src/engine/ai/netbin';
import { PLAYOUT_RULES } from '../../src/engine/ai/playout-rules';
import { faceValues } from '../../src/engine/ai/review';
import { RolloutEngine } from '../../src/engine/ai/rollout';
import { ownerValues } from '../../src/engine/ai/search';
import { positionKey } from '../../src/engine/rng';
import { flags } from './common';

const a = flags(process.argv.slice(2));
const N = Number(a.n ?? 1024);
const root = new URL('../../../', import.meta.url);
const bytes = new Uint8Array(readFileSync(new URL('src/engine/ai/extreme-net.bin', root)));
const net = new Net(decodeNet(bytes));
const engine = await RolloutEngine.create(readFileSync(new URL('src/engine/ai/ludo_wasm.wasm', root)), bytes, PLAYOUT_RULES);
const summary = process.env.GITHUB_STEP_SUMMARY;
const md = (line: string) => {
  console.log(line);
  if (summary) appendFileSync(summary, line + '\n');
};

/** A roll state: these tokens, `who` to roll, nothing in the tray. */
function position(seats: Seat[], tokens: Partial<Record<Color, number[]>>, who: Color): GameState {
  const g = createGame(seats, who);
  const players = g.players.map((p) => ({ ...p, tokens: [...(tokens[p.color] ?? [-1, -1, -1, -1])] }));
  return { ...g, players, current: players.findIndex((p) => p.color === who), phase: 'roll', dice: null, rolls: [], sixes: 0, moves: [], event: null };
}
const TWO: Seat[] = [{ color: 'blue', owner: 0, bot: true }, { color: 'red', owner: 1, bot: true }];
const FOUR: Seat[] = (['blue', 'green', 'red', 'yellow'] as const).map((color, owner) => ({ color, owner, bot: true }));
const POSITIONS: [string, GameState][] = [
  ['2p opening (all at home)', position(TWO, {}, 'blue')],
  ['2p mid-game race', position(TWO, { blue: [10, 22, -1, 30], red: [5, 15, 28, -1] }, 'blue')],
  ['2p endgame, near home', position(TWO, { blue: [49, 52, 56, 54], red: [45, 50, 53, 56] }, 'blue')],
  ['2p with a pair', position(TWO, { blue: [20, 20, -1, 8], red: [12, 33, -1, -1] }, 'blue')],
  ['4p mid-game', position(FOUR, { blue: [10, 22, -1, 30], green: [5, 15, -1, -1], red: [28, -1, -1, 3], yellow: [40, 12, -1, -1] }, 'blue')],
];

const pct = (x: number) => (100 * x).toFixed(2);

// 1. The luck of 6 -> 6 -> 6, the app's way: faceValues (the net), each face 1/6.
md(`## #135: a run of sixes in the luck`);
md('');
md('### 1. The luck of 6, 6, 6 (points of win chance; the app\'s own computation, fair dice)');
md('');
md('| position | 1st 6 | 2nd 6 | 3rd 6 (cancels) | sum | the roller\'s net chance: before → after the run |');
md('|---|---:|---:|---:|---:|---|');
for (const [name, s0] of POSITIONS) {
  const owner = s0.players[s0.current]!.owner;
  const people = Math.max(...s0.players.map((p) => p.owner)) + 1;
  let s = s0;
  const lucks: number[] = [];
  for (let k = 0; k < 3; k++) {
    const v = faceValues(net, s);
    const expect = v.reduce((t, x) => t + x / 6, 0);
    lucks.push(100 * (v[5]! - expect));
    s = roll(s, () => 0, 6);
  }
  const before = ownerValues(net, s0, people)[owner]!;
  const after = ownerValues(net, s, people)[owner]!;
  const sum = lucks.reduce((t, x) => t + x, 0);
  md(`| ${name} | ${lucks[0]!.toFixed(2)} | ${lucks[1]!.toFixed(2)} | ${lucks[2]!.toFixed(2)} | **${sum.toFixed(2)}** | ${pct(before)}% → ${pct(after)}% (${s.players[s.current]!.color} to ${s.phase}) |`);
  console.log('SIXES ' + JSON.stringify({ name, lucks, sum, before, after }));
}
md('');

// 2. The net against playouts at sixes 0, 1, 2 (2p positions: the roller's chance is 1 - the opponent's).
/** The best move's chance for the mover, by the full review at N playouts per move. */
const bestByReview = (t: GameState, seed: number) => {
  const v = engine.review(t, N, seed);
  return v.mean[v.best]!;
};
/** The value for `me` of the roll state `s` (anyone to roll): the fair expectation over the faces. */
function playoutValue(s: GameState, me: number, seed: number, memo: Map<string, number>, depth = 0): number {
  const key = `${me}|${positionKey(s)}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let total = 0;
  for (let f = 1; f <= 6; f++) total += valueAfter(roll(s, () => 0, f), me, seed + f, memo, depth) / 6;
  memo.set(key, total);
  return total;
}
function valueAfter(t: GameState, me: number, seed: number, memo: Map<string, number>, depth: number): number {
  if (t.phase === 'over') return ownerRanking(t)[0] === me ? 1 : 0;
  const mover = t.players[t.current]!.owner;
  // Past a few levels of sixes and passes (rare), the net.
  if (depth >= 4 && t.phase === 'roll') return ownerValues(net, t, 2)[me]!;
  // One legal move: nothing for the review to compare (it plays nothing out), so play it and go on.
  if (t.phase === 'move' && t.moves.length === 1) return valueAfter(move(t, t.moves[0]!), me, seed, memo, depth);
  const v = t.phase === 'move' ? bestByReview(t, seed) : playoutValue(t, mover, seed * 7 + 1, memo, depth + 1);
  return mover === me ? v : 1 - v;
}

md(`### 2. The net against playouts (${N} paired playouts per move), the roller's chance in %, 2p`);
md('');
md('| position | sixes, tray | net | playouts (seed 1) | playouts (seed 2) | net − playouts (mean of the seeds) |');
md('|---|---|---:|---:|---:|---:|');
for (const [name, s0] of POSITIONS.filter(([n]) => n.startsWith('2p'))) {
  const me = s0.players[s0.current]!.owner;
  let s = s0;
  for (let k = 0; k < 3; k++) {
    const nv = ownerValues(net, s, 2)[me]!;
    const pv = [1, 2].map((seed) => playoutValue(s, me, 1000 * seed + 17 * k, new Map()));
    const mean = (pv[0]! + pv[1]!) / 2;
    md(`| ${name} | ${s.sixes}, [${s.rolls.join(', ')}] | ${pct(nv)} | ${pct(pv[0]!)} | ${pct(pv[1]!)} | ${(100 * (nv - mean)).toFixed(2)} |`);
    console.log('SIXVAL ' + JSON.stringify({ name, sixes: s.sixes, tray: s.rolls, net: nv, playouts: pv }));
    s = roll(s, () => 0, 6);
  }
}
md('');
