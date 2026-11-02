// Would a Float32 net do (#98)? Measures the Extreme net rounded to Float32 against the shipped Float64 one.
// No app change: .github/workflows/net-f32.yml runs it.
//   node tools/ai/dist/net_f32.mjs make
//       writes tools/ai/dist/extreme-net-f32.json (every weight Math.fround'ed: the values a Float32 .bin
//       decodes to) for the Rust arena's strength check, and prints the .bin sizes (Float64 and Float32, raw
//       and gzip).
//   node tools/ai/dist/net_f32.mjs review --layout 2p --mover hard [--games 10] [--from 1]
//       reviews the REVIEW_CALIB games (review_calib's generator and seeds) with the app's engine and review
//       twice, once per net, and prints the label agreement (all decisions, and key ones: either side
//       inaccuracy or worse), the accuracy change per game (points), and how often Extreme's own choice
//       (choose, 128 playouts) differs.
// Both engines load through init_bin; the f32 one from the rounded weights stored as Float64, which is
// exactly what a Float32 .bin would decode to.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createGame, move, roll, seededDie, seeded, type BotLevel, type GameRecord, type GameState, type Seat } from '../../src/engine';
import { chooseBotMove } from '../../src/engine/ai/levels';
import type { NetJSON } from '../../src/engine/ai/net';
import { encodeNet } from '../../src/engine/ai/netbin';
import { PLAYOUT_RULES } from '../../src/engine/ai/playout-rules';
import { accuracyOf, reviewMoves, type Label, type Reviewer } from '../../src/engine/ai/review';
import { RolloutEngine } from '../../src/engine/ai/rollout';
import { replay } from '../../src/engine/record';
import { flags, MODES } from './common';

const argv = process.argv.slice(2);
const task = argv[0];
const a = flags(argv.slice(1));
const root = new URL('../../../', import.meta.url);
const json = JSON.parse(readFileSync(new URL('src/engine/ai/extreme-net.json', root), 'utf8')) as NetJSON;
const summary = process.env.GITHUB_STEP_SUMMARY;
const md = (line: string) => {
  console.log(line);
  if (summary) appendFileSync(summary, line + '\n');
};

/** The net with every weight rounded to Float32 (inputs, being indices, stay as they are). */
function rounded(n: NetJSON): NetJSON {
  const r = (l: { W: number[][]; b: number[] }) => ({ W: l.W.map((row) => row.map(Math.fround)), b: l.b.map(Math.fround) });
  return { inputs: n.inputs, trunk: n.trunk.map(r), pool: r(n.pool), out: r(n.out) };
}

/** A Float32 .bin's bytes: netbin.ts encodeNet's layout, with each weight as 4 bytes instead of 8. */
function encode32(net: NetJSON): Uint8Array {
  const layers = [...net.trunk, net.pool, net.out];
  let size = 4 * (4 + net.inputs.length);
  for (const l of layers) size += 8 + 4 * (l.b.length * l.W[0]!.length + l.b.length);
  const v = new DataView(new ArrayBuffer(size));
  let o = 0;
  const u32 = (x: number) => (v.setUint32(o, x, true), (o += 4));
  const f32 = (x: number) => (v.setFloat32(o, x, true), (o += 4));
  u32(0x54454e4c);
  u32(1);
  u32(net.inputs.length);
  net.inputs.forEach(u32);
  u32(net.trunk.length);
  for (const l of layers) {
    u32(l.b.length);
    u32(l.W[0]!.length);
    for (const row of l.W) row.forEach(f32);
    l.b.forEach(f32);
  }
  return new Uint8Array(v.buffer);
}

const f32 = rounded(json);

if (task === 'make') {
  mkdirSync(new URL('tools/ai/dist/', root), { recursive: true });
  writeFileSync(new URL('tools/ai/dist/extreme-net-f32.json', root), JSON.stringify(f32));
  const b64 = encodeNet(json);
  const real32 = encode32(json);
  let maxRel = 0;
  [...json.trunk, json.pool, json.out].forEach((l, k) => {
    const g = [...f32.trunk, f32.pool, f32.out][k]!;
    l.W.flat().forEach((w, i) => (maxRel = w ? Math.max(maxRel, Math.abs(g.W.flat()[i]! - w) / Math.abs(w)) : maxRel));
  });
  md('### Net file: Float64 (shipped) vs Float32');
  md('');
  md('| | raw | gzip |');
  md('|---|---:|---:|');
  md(`| extreme-net.bin, Float64 | ${(b64.length / 1024).toFixed(1)} kB | ${(gzipSync(b64, { level: 9 }).length / 1024).toFixed(1)} kB |`);
  md(`| extreme-net.bin, Float32 | ${(real32.length / 1024).toFixed(1)} kB | ${(gzipSync(real32, { level: 9 }).length / 1024).toFixed(1)} kB |`);
  md('');
  md(`Largest relative change of a weight: ${maxRel.toExponential(2)}.`);
  md('');
} else if (task === 'review') {
  const layout = a.layout ?? '2p';
  const mover = (a.mover ?? 'hard') as BotLevel | 'first';
  const games = Number(a.games ?? 10);
  const from = Number(a.from ?? 1);
  const wasm = readFileSync(new URL('src/engine/ai/ludo_wasm.wasm', root));
  const e64 = await RolloutEngine.create(wasm, encodeNet(json), PLAYOUT_RULES);
  const e32 = await RolloutEngine.create(wasm, encodeNet(f32), PLAYOUT_RULES);
  const reviewer = (e: RolloutEngine): Reviewer => async (s, n, seed, ask) => e.reviewFast(s, n, seed, ask);

  /** review_calib's game: seat 0's person at `mover` ("first": always the first legal move), everyone else Hard, the app's dice. */
  const game = (seed: number): GameRecord => {
    const seats: Seat[] = MODES[layout]!.seats().map((s) => ({ ...s, bot: true, level: s.owner === 0 && mover !== 'first' ? mover : 'hard' }));
    const rng = seeded(seed * 31 + 7);
    let s = createGame(seats, seats[seed % seats.length]!.color, MODES[layout]!.singles);
    let events = '';
    for (let n = 0; s.phase !== 'over' && n < 20000; n++) {
      if (s.phase === 'roll') {
        const f = seededDie(seed, s);
        events += String(f);
        s = roll(s, () => 0, f);
      } else {
        const m = mover === 'first' && s.players[s.current]!.owner === 0 ? s.moves[0]! : chooseBotMove(s, rng);
        events += (m.tokens.length === 1 ? 'abcd'[m.tokens[0]!] : 'efghij'[['01', '02', '03', '12', '13', '23'].indexOf([...m.tokens].sort().join(''))]) + m.roll;
        s = move(s, m);
      }
    }
    return { v: 1, seats, first: seats[seed % seats.length]!.color, singles: MODES[layout]!.singles || undefined, seed, events };
  };

  const KEY = new Set<Label>(['inaccuracy', 'mistake', 'blunder']);
  let n = 0, same = 0, keyN = 0, keySame = 0, choices = 0, choiceSame = 0;
  const dAcc: number[] = [];
  for (let g = 0; g < games; g++) {
    const rec = game(from + g);
    const r = replay(rec);
    if (!r.ok) throw new Error(`game ${from + g} does not replay: ${r.error}`);
    const states = r.states as GameState[];
    const RA = await reviewMoves(rec, states, [0], reviewer(e64));
    const A = new Map(RA.map((m) => [m.at, m.label]));
    const B = await reviewMoves(rec, states, [0], reviewer(e32));
    const da = 100 * (accuracyOf(B) - accuracyOf(RA));
    if (Number.isFinite(da)) dAcc.push(Math.abs(da));
    for (const m of B) {
      const l = A.get(m.at);
      if (!l) continue;
      n++;
      if (l === m.label) same++;
      if (KEY.has(l) || KEY.has(m.label)) {
        keyN++;
        if (l === m.label) keySame++;
      }
      const s = states[m.at]!;
      choices++;
      if (JSON.stringify(e64.choose(s, 128, m.at)) === JSON.stringify(e32.choose(s, 128, m.at))) choiceSame++;
    }
  }
  const pct = (x: number, t: number) => (t ? `${((100 * x) / t).toFixed(2)}% (${x}/${t})` : '-');
  const meanD = dAcc.length ? dAcc.reduce((s, x) => s + x, 0) / dAcc.length : NaN;
  const maxD = dAcc.length ? Math.max(...dAcc) : NaN;
  console.log('F32 ' + JSON.stringify({ layout, mover, games, decisions: n, same, keyN, keySame, choices, choiceSame, meanAbsDAcc: meanD, maxAbsDAcc: maxD }));
  md(`### Review with a Float32 net: ${layout} ${mover}, REVIEW_CALIB seeds ${from}..${from + games - 1}`);
  md('');
  md(`| decisions | labels unchanged | key labels unchanged | Extreme's choice unchanged | mean / max abs Δ accuracy per game (pts) |`);
  md('|---:|---:|---:|---:|---:|');
  md(`| ${n} | ${pct(same, n)} | ${pct(keySame, keyN)} | ${pct(choiceSame, choices)} | ${meanD.toFixed(2)} / ${maxD.toFixed(2)} |`);
  md('');
} else {
  throw new Error(`unknown task ${task}: make | review`);
}
