// #178: a playout-budget study for the review. On the REVIEW_CALIB games of the #138 study, seat 0's decisions
// are reviewed by the app's own path (review.ts reviewMoves: the stakes order, the screen, the race, the full
// review and its top-ups up to PLAYOUTS_MAX) under each arm, and compared with the study's 1,024-playout
// reference (its decisions.jsonl), labelled under today's rules (RULES, v4):
//   today        the app as it is: base 128, no screen (SKIP_BELOW 0), the race's own z schedule
//   skip@N       decisions whose net-screen spread is under N points are Best by the net, no playouts
//   z@Z          the race settles Best at Z standard errors at every look (looser than the 3.0 / 2.5 schedule)
//   base@B       B playouts per candidate instead of 128, with today's top-ups near a cut (EDGE 1.5)
//   a+b          arms combined, e.g. skip@2+z@2
// Reports per arm (and per layout): key-label agreement with the reference, all-label agreement, |Δaccuracy|
// per game against today's review of the same game and seed, and the review time per game.
//   node tools/ai/dist/review_budget.mjs --task eval --layout 2p --mover hard [--games 5] [--seeds 2] [--arms today,skip@2,...] [--wasm simd]
//   node tools/ai/dist/review_budget.mjs --task report <ref dir> <eval dirs...>
// .github/workflows/review-budget.yml runs it (study/budget* branches).
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGame, move, roll, seededDie, seeded, type BotLevel, type GameRecord, type GameState, type Seat } from '../../src/engine';
import { chooseBotMove } from '../../src/engine/ai/levels';
import { PLAYOUT_RULES } from '../../src/engine/ai/playout-rules';
import { accuracyOf, labelOf, layoutKey, reviewMoves, RULES, turned, PLAYOUTS, type Label, type MoveReview, type ReviewOptions, type Reviewer } from '../../src/engine/ai/review';
import { RolloutEngine } from '../../src/engine/ai/rollout';
import { replay } from '../../src/engine/record';
import { flags, MODES } from './common';

const argv = process.argv.slice(2);
const a = flags(argv);
const task = a.task ?? 'eval';
const summary = process.env.GITHUB_STEP_SUMMARY;
const md = (line: string) => {
  console.log(line);
  if (summary) appendFileSync(summary, line + '\n');
};
const KEY = new Set<Label>(['inaccuracy', 'mistake', 'blunder']);

interface Ref {
  gap: number;
  se: number;
  mine: number;
  best: number;
}
interface Row {
  layout: string;
  mover: string;
  game: number;
  arm: string;
  seed: number;
  ms: number;
  accuracy: number;
  /** per decision: [at, label] */
  moves: [number, Label][];
}

/** An arm's review options and base: "today", "skip@N", "z@Z", "base@B", joined by "+". */
function armOf(name: string): { base: number; opts: ReviewOptions } {
  const opts: ReviewOptions = { order: 'stakes', rules: RULES };
  let base = PLAYOUTS;
  for (const part of name.split('+')) {
    const [k, v] = part.split('@');
    if (k === 'skip') opts.skipBelow = Number(v);
    else if (k === 'z') opts.raceZ = Number(v);
    else if (k === 'base') base = Number(v);
    else if (k !== 'today') throw new Error(`unknown arm ${part}`);
  }
  return { base, opts };
}

const walk = (dirs: string[], name: string, each: (line: string) => void) => {
  const go = (p: string) => {
    if (statSync(p).isDirectory()) for (const f of readdirSync(p)) go(join(p, f));
    else if (p.endsWith(name)) for (const line of readFileSync(p, 'utf8').split('\n')) if (line.trim()) each(line);
  };
  dirs.forEach(go);
};

if (task === 'eval') {
  const layout = a.layout ?? '2p';
  const mover = (a.mover ?? 'hard') as BotLevel;
  const games = Number(a.games ?? 5);
  const from = Number(a.from ?? 1);
  const seeds = Number(a.seeds ?? 2);
  const arms = (a.arms ?? 'today,skip@1,skip@2,skip@3,z@2,z@1.5,base@64').split(',');
  const root = new URL('../../../', import.meta.url);
  // The SIMD build gives every value the same as the plain one (tests/wasmSimd.test.ts), only faster.
  const wasm = a.wasm === 'plain' ? 'ludo_wasm.wasm' : 'ludo_wasm_simd.wasm';
  const engine = await RolloutEngine.create(readFileSync(new URL(`src/engine/ai/${wasm}`, root)), new Uint8Array(readFileSync(new URL('src/engine/ai/extreme-net.bin', root))), PLAYOUT_RULES);
  const reviewer: Reviewer = async (s, n, seed, ask) => engine.reviewFast(s, n, seed, ask);
  /** review_cuts.ts's game (the #138 study's). */
  const game = (seed: number): GameRecord => {
    const seats: Seat[] = MODES[layout]!.seats().map((s) => ({ ...s, bot: true, level: s.owner === 0 ? mover : 'hard' }));
    const rng = seeded(seed * 31 + 7);
    let s = createGame(seats, seats[seed % seats.length]!.color, MODES[layout]!.singles);
    let events = '';
    for (let n = 0; s.phase !== 'over' && n < 20000; n++) {
      if (s.phase === 'roll') {
        const f = seededDie(seed, s);
        events += String(f);
        s = roll(s, () => 0, f);
      } else {
        const m = chooseBotMove(s, rng);
        events += (m.tokens.length === 1 ? 'abcd'[m.tokens[0]!] : 'efghij'[['01', '02', '03', '12', '13', '23'].indexOf([...m.tokens].sort().join(''))]!) + m.roll;
        s = move(s, m);
      }
    }
    return { v: 1, seats, first: seats[seed % seats.length]!.color, singles: MODES[layout]!.singles || undefined, seed, events };
  };
  writeFileSync('budget.jsonl', '');
  for (let g = from; g < from + games; g++) {
    const base = game(g);
    const states = replay(base).states as GameState[];
    const key = layoutKey(states[0]!);
    for (let k = 0; k < seeds; k++)
      for (const arm of arms) {
        const rec = { ...base, seed: g * 1000 + k };
        const { base: n, opts } = armOf(arm);
        const t = performance.now();
        const out: MoveReview[] = await reviewMoves(rec, states, [0], reviewer, undefined, n, undefined, opts);
        const row: Row = { layout: key, mover, game: g, arm, seed: k, ms: performance.now() - t, accuracy: accuracyOf(out), moves: out.map((m) => [m.at, m.label]) };
        appendFileSync('budget.jsonl', JSON.stringify(row) + '\n');
      }
    console.log(`game ${g} done`);
  }
} else {
  const dirs = argv.filter((x, i) => !x.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  const refs = new Map<string, Ref>();
  walk(dirs, 'decisions.jsonl', (line) => {
    const r = JSON.parse(line) as { layout: string; mover: string; game: number; at: number; ref: Ref };
    refs.set(`${r.layout}/${r.mover}/${r.game}/${r.at}`, r.ref);
  });
  const rows: Row[] = [];
  walk(dirs, 'budget.jsonl', (line) => rows.push(JSON.parse(line) as Row));
  const arms = [...new Set(rows.map((r) => r.arm))];
  const layouts = [...new Set(rows.map((r) => r.layout))].sort();
  const gameKey = (r: Row) => `${r.layout}/${r.mover}/${r.game}/${r.seed}`;
  const today = new Map(rows.filter((r) => r.arm === 'today').map((r) => [gameKey(r), r]));
  const refLabel = (r: Ref, layout: string) => turned(labelOf(r.gap, r.se, layout, RULES), r.mine / 100, r.best / 100, RULES);
  const stats = (rs: Row[]) => {
    let all = 0, same = 0, keyN = 0, keySame = 0, dacc = 0, daccN = 0;
    for (const r of rs) {
      for (const [at, label] of r.moves) {
        const ref = refs.get(`${r.layout}/${r.mover}/${r.game}/${at}`);
        if (!ref) continue;
        const want = refLabel(ref, r.layout);
        all++;
        if (want === label) same++;
        if (KEY.has(want) || KEY.has(label)) {
          keyN++;
          if (want === label) keySame++;
        }
      }
      const t = today.get(gameKey(r));
      if (t && Number.isFinite(t.accuracy) && Number.isFinite(r.accuracy)) {
        dacc += Math.abs(100 * (r.accuracy - t.accuracy));
        daccN++;
      }
    }
    const ms = rs.reduce((s, r) => s + r.ms, 0) / Math.max(1, new Set(rs.map(gameKey)).size);
    return { all, same, keyN, keySame, dacc: daccN ? dacc / daccN : NaN, ms };
  };
  const pct = (x: number, n: number) => (n ? `${((100 * x) / n).toFixed(1)}%` : '-');
  const t0 = stats(rows.filter((r) => r.arm === 'today'));
  md('## #178: the review\'s playout budget against the 1,024-playout reference');
  md('');
  md(`${new Set(rows.map(gameKey)).size} game reviews per arm (the #138 games × seeds), seat 0's decisions, through the app's own review (reviewMoves: the stakes order, the screen, the race, top-ups up to 1,024). Labels under today's rules (v4) against the reference; |Δacc| against today's review of the same game and seed; time on the CI runner (node, the SIMD engine build).`);
  md('');
  md('| arm | key labels agreeing | all labels agreeing | \\|Δacc\\| per game | review time per game | time saved | passes the bar |');
  md('|---|---:|---:|---:|---:|---:|---|');
  for (const arm of arms) {
    const s = stats(rows.filter((r) => r.arm === arm));
    const key = s.keyN ? (100 * s.keySame) / s.keyN : NaN;
    const ok = arm === 'today' ? '(today)' : key >= (100 * t0.keySame) / t0.keyN - 1 && s.dacc < 1 && s.ms < t0.ms ? 'yes' : 'no';
    md(`| ${arm} | ${pct(s.keySame, s.keyN)} (${s.keySame}/${s.keyN}) | ${pct(s.same, s.all)} | ${arm === 'today' ? '–' : s.dacc.toFixed(2)} | ${(s.ms / 1000).toFixed(1)} s | ${arm === 'today' ? '–' : `${(100 * (1 - s.ms / t0.ms)).toFixed(0)}%`} | ${ok} |`);
  }
  md('');
  md('By layout (key labels agreeing / |Δacc| / time per game):');
  md('');
  md('| layout | ' + arms.join(' | ') + ' |');
  md('|---|' + arms.map(() => '---').join('|') + '|');
  for (const L of layouts)
    md(`| ${L} | ` + arms.map((arm) => {
      const s = stats(rows.filter((r) => r.arm === arm && r.layout === L));
      return `${pct(s.keySame, s.keyN)} / ${arm === 'today' ? '–' : s.dacc.toFixed(2)} / ${(s.ms / 1000).toFixed(1)} s`;
    }).join(' | ') + ' |');
  md('');
}
