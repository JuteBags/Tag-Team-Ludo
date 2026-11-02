// Measures the game review's speed (#101, .github/workflows/review-speed.yml): reviews the same fixed-seed bot
// games (seat 0's person at `mover`, every other seat Hard, the app's dice) with the app's WebAssembly engine
// in several ways, and compares each with the full review at 128 playouts (arm B):
//   A  the full review, 256 playouts (the review before #101)
//   B  the full review, 128 playouts (#101 step 5, the reference)
//   C  the race (fast, no net screen), in game order
//   D  the race and the net screen (SKIP_BELOW, or --skip), biggest stakes first (what the app runs)
//   node tools/ai/dist/review_speed.mjs --layout 2p --mover hard --task eval [--arms BCD] [--from 101] [--games 12] [--skip 1.5]
//   node tools/ai/dist/review_speed.mjs --layout 2p --mover hard --task tune [--from 1] [--games 8]
// eval prints one SPEED line per arm: time to the first key verdict (a mistake or blunder), total time,
// playouts, label agreement with B (all decisions, and those either calls inaccuracy or worse), the mean
// |Δ accuracy| per game in points, the skip and race-Best shares, and the spread kept on race-Best decisions
// against B's (selection bias). tune prints TUNE: per net-spread threshold, the share of decisions the
// screen would skip and how many of those B labels other than Best, as key moves, or as meaningful.
// Both print a Markdown table for the run summary, and write decisions.jsonl (one line per decision and arm).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createGame, move, roll, seededDie, seeded, type BotLevel, type GameRecord, type GameState, type Seat } from '../../src/engine';
import { chooseBotMove } from '../../src/engine/ai/levels';
import type { NetJSON } from '../../src/engine/ai/net';
import { PLAYOUT_RULES } from '../../src/engine/ai/playout-rules';
import { accuracyOf, MEANINGFUL, reviewMoves, SKIP_BELOW, spreadOf, type Label, type MoveReview, type ReviewOptions, type Reviewer } from '../../src/engine/ai/review';
import { RolloutEngine } from '../../src/engine/ai/rollout';
import { replay } from '../../src/engine/record';
import { flags, MODES } from './common';

const a = flags(process.argv.slice(2));
const layout = a.layout ?? '2p';
const mover = (a.mover ?? 'hard') as BotLevel | 'first';
const task = a.task ?? 'eval';
const from = Number(a.from ?? (task === 'tune' ? 1 : 101));
const games = Number(a.games ?? (task === 'tune' ? 8 : 12));
const arms = (a.arms ?? 'BCD').toUpperCase().split('');
const skip = Number(a.skip ?? SKIP_BELOW);
const root = new URL('../../../', import.meta.url);
const wasm = readFileSync(new URL('src/engine/ai/ludo_wasm.wasm', root));
const net = JSON.parse(readFileSync(new URL('src/engine/ai/extreme-net.json', root), 'utf8')) as NetJSON;
const engine = await RolloutEngine.create(wasm, net, PLAYOUT_RULES);
if (!engine.hasFast) throw new Error('this ludo_wasm.wasm has no review_fast: build it with wasm.yml');
const summary = process.env.GITHUB_STEP_SUMMARY;
const md = (line: string) => {
  console.log(line);
  if (summary) appendFileSync(summary, line + '\n');
};
writeFileSync('decisions.jsonl', '');
const dump = (o: object) => appendFileSync('decisions.jsonl', JSON.stringify(o) + '\n');

/** One game: seat 0's person plays at `mover` ("first": always the first legal move), everyone else at Hard; the app's dice (as review_calib). */
function game(seed: number): GameRecord {
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
}

/** The engine as a Reviewer that counts the playouts it spends. */
function counting() {
  let playouts = 0;
  const reviewer: Reviewer = async (s, n, seed, ask) => {
    const v = engine.reviewFast(s, n, seed, ask);
    playouts += v.count ? v.count.reduce((x, y) => x + y, 0) : v.mean.length > 1 ? n * v.mean.length : 0;
    return v;
  };
  return { reviewer, playouts: () => playouts };
}

const KEY = new Set<Label>(['inaccuracy', 'mistake', 'blunder']);
const MISTAKE = new Set<Label>(['mistake', 'blunder']);
const ARMS: Record<string, { base: number; opts: ReviewOptions }> = {
  A: { base: 256, opts: { fast: false } },
  B: { base: 128, opts: { fast: false } },
  C: { base: 128, opts: { skipBelow: 0 } },
  D: { base: 128, opts: { skipBelow: skip, order: 'stakes' } },
};

interface Run {
  moves: MoveReview[];
  ms: number;
  firstKeyMs: number | null;
  playouts: number;
}

async function run(rec: GameRecord, states: GameState[], arm: string): Promise<Run> {
  const { reviewer, playouts } = counting();
  const t0 = performance.now();
  let firstKeyMs: number | null = null;
  const moves = await reviewMoves(rec, states, [0], reviewer, (m) => {
    if (firstKeyMs === null && MISTAKE.has(m.label)) firstKeyMs = performance.now() - t0;
  }, ARMS[arm]!.base, undefined, ARMS[arm]!.opts);
  return { moves, ms: performance.now() - t0, firstKeyMs, playouts: playouts() };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN;
};
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const pct = (x: number, n: number) => (n ? ((100 * x) / n).toFixed(1) + '%' : '-');

if (task === 'tune') {
  // The net screen's threshold: B's verdicts against the net's spread, per decision.
  const rows: { spread: number; label: Label; full: number }[] = [];
  for (let g = 0; g < games; g++) {
    const rec = game(from + g);
    const r = replay(rec);
    if (!r.ok) throw new Error(`game ${from + g} does not replay: ${r.error}`);
    const b = await run(rec, r.states, 'B');
    for (const m of b.moves) {
      const sc = engine.reviewFast(r.states[m.at]!, 0, 0, { mode: 'screen' });
      const spread = 100 * Math.max(...sc.gap);
      rows.push({ spread, label: m.label, full: spreadOf(m) });
      dump({ task, layout, mover, game: from + g, at: m.at, net: +spread.toFixed(2), label: m.label, spread: m.gaps ? spreadOf(m) : null });
    }
  }
  md(`### Net screen tuning: ${layout} ${mover}, seeds ${from}..${from + games - 1}, ${rows.length} decisions`);
  md('');
  md('| net spread under | skipped | B not Best | B key (inacc.+) | B mistake+ | B meaningful (spread ≥ 3) |');
  md('|---|---|---|---|---|---|');
  const out: object[] = [];
  for (const t of [0.5, 1, 1.5, 2, 3, 4, 5]) {
    const sk = rows.filter((x) => x.spread < t);
    const row = { t, skipped: sk.length, notBest: sk.filter((x) => x.label !== 'best').length, key: sk.filter((x) => KEY.has(x.label)).length, mistake: sk.filter((x) => MISTAKE.has(x.label)).length, meaningful: sk.filter((x) => x.full >= MEANINGFUL).length };
    out.push(row);
    md(`| ${t} | ${pct(row.skipped, rows.length)} (${row.skipped}) | ${row.notBest} | ${row.key} | ${row.mistake} | ${row.meaningful} |`);
  }
  md('');
  console.log('TUNE ' + JSON.stringify({ layout, mover, seeds: `${from}..${from + games - 1}`, decisions: rows.length, rows: out }));
} else {
  const want = [...new Set(['B', ...arms])];
  const per: Record<string, { runs: Run[]; ref: Run[] }> = Object.fromEntries(want.map((k) => [k, { runs: [], ref: [] }]));
  for (let g = 0; g < games; g++) {
    const rec = game(from + g);
    const r = replay(rec);
    if (!r.ok) throw new Error(`game ${from + g} does not replay: ${r.error}`);
    const done: Record<string, Run> = {};
    for (const k of want) done[k] = await run(rec, r.states, k);
    for (const k of want) {
      per[k]!.runs.push(done[k]!);
      per[k]!.ref.push(done.B!);
      for (const m of done[k]!.moves) dump({ task, layout, mover, arm: k, game: from + g, at: m.at, label: m.label, gap: +m.gap.toFixed(2), spread: m.gaps ? spreadOf(m) : null, approx: m.approx ?? null });
    }
  }
  md(`### Review speed: ${layout} ${mover}, seeds ${from}..${from + games - 1} (B = full review at 128)`);
  md('');
  md('| arm | decisions | first mistake (median s) | total (s) | playouts | agree all | agree key | mean abs Δacc (pts) | net skips | race Best | race-Best spread vs B |');
  md('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const k of want) {
    const { runs, ref } = per[k]!;
    let n = 0;
    let same = 0;
    let keyN = 0;
    let keySame = 0;
    let skips = 0;
    let raceBest = 0;
    let sArm = 0;
    let sRef = 0;
    const dAcc: number[] = [];
    runs.forEach((x, g) => {
      const byAt = new Map(ref[g]!.moves.map((m) => [m.at, m]));
      for (const m of x.moves) {
        const b = byAt.get(m.at);
        if (!b) continue;
        n++;
        if (m.label === b.label) same++;
        if (KEY.has(m.label) || KEY.has(b.label)) {
          keyN++;
          if (m.label === b.label) keySame++;
        }
        if (m.approx === 'net') skips++;
        if (m.approx === 'race') {
          raceBest++;
          sArm += spreadOf(m);
          sRef += spreadOf(b);
        }
      }
      const da = 100 * (accuracyOf(x.moves) - accuracyOf(ref[g]!.moves));
      if (Number.isFinite(da)) dAcc.push(Math.abs(da));
    });
    const firsts = runs.map((x) => x.firstKeyMs).filter((x): x is number => x !== null);
    const total = runs.reduce((s, x) => s + x.ms, 0) / 1000;
    const playouts = runs.reduce((s, x) => s + x.playouts, 0);
    const stats = {
      layout, mover, arm: k, games, decisions: n,
      firstMistakeS: +(median(firsts) / 1000).toFixed(2), gamesWithMistake: firsts.length,
      totalS: +total.toFixed(1), playouts,
      agree: +(same / Math.max(1, n)).toFixed(4), agreeKey: +(keySame / Math.max(1, keyN)).toFixed(4), keyN,
      meanAbsDAcc: +(dAcc.reduce((s, x) => s + x, 0) / Math.max(1, dAcc.length)).toFixed(2),
      netSkips: skips, raceBest, raceBestSpreadRatio: sRef ? +(sArm / sRef).toFixed(4) : null,
    };
    console.log('SPEED ' + JSON.stringify(stats));
    md(`| ${k} | ${n} | ${f1(stats.firstMistakeS)} (${firsts.length} games) | ${f1(total)} | ${playouts} | ${pct(same, n)} | ${pct(keySame, keyN)} of ${keyN} | ${stats.meanAbsDAcc} | ${pct(skips, n)} | ${pct(raceBest, n)} | ${stats.raceBestSpreadRatio ?? '-'} |`);
  }
  md('');
}
