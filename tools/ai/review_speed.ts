// Measures the game review's speed (#101, .github/workflows/review-speed.yml): reviews the same fixed-seed bot
// games (seat 0's person at `mover`, every other seat Hard, the app's dice) with the app's WebAssembly engine
// in several ways ("arms"), and compares each with the full review at 128 playouts (arm B):
//   A  the full review, 256 playouts (the review before #101)
//   B  the full review, 128 playouts (#101 step 5, the reference); top-ups reuse playouts (same values)
//   C  the race, settling Best by the engine's schedule (rollout.rs best_z), in game order
//   F  the race, settling Best at 2.7 se at every look (Bonferroni), in game order
//   D  the race and the net skip (--skip points, default 1), biggest stakes first
//   E  the race, biggest stakes first by the net (what the app runs)
// Tasks:
//   eval    node tools/ai/dist/review_speed.mjs --task eval --layout 2p --mover hard [--arms CFE] [--from 101] [--games 10]
//           writes games.jsonl (per game and arm: times, playouts, accuracy) and decisions.jsonl (per decision
//           and arm: label, gap, spread, approx), and prints the tables for its own games.
//   report  node tools/ai/dist/review_speed.mjs --task report <dir> ...   reads every games.jsonl and
//           decisions.jsonl under the dirs and prints the tables per layout and mover and per layout.
//   tune    node tools/ai/dist/review_speed.mjs --task tune --layout 2p --mover hard [--from 1] [--games 8]
//           the net skip's threshold table: per net spread, the decisions it would skip that B labels
//           otherwise.
// The tables (Markdown, also appended to the run summary): per arm, the median time to the first key verdict
// (inaccuracy or worse) and to the first mistake, the total time, playouts, label agreement with B on every
// decision and on key ones (either side calls it inaccuracy or worse), the mean |Δ accuracy| per game in
// points, the net-skip and race-Best shares, and the spread kept on race-Best decisions against B's.
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGame, move, roll, seededDie, seeded, type BotLevel, type GameRecord, type GameState, type Seat } from '../../src/engine';
import { chooseBotMove } from '../../src/engine/ai/levels';
import { PLAYOUT_RULES } from '../../src/engine/ai/playout-rules';
import { accuracyOf, MEANINGFUL, reviewMoves, SKIP_BELOW, spreadOf, type Label, type ReviewOptions, type Reviewer } from '../../src/engine/ai/review';
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
const MISTAKE = new Set<Label>(['mistake', 'blunder']);

interface GameRow {
  layout: string;
  mover: string;
  arm: string;
  game: number;
  ms: number;
  firstKeyMs: number | null;
  firstMistakeMs: number | null;
  playouts: number;
  acc: number | null;
}
interface DecisionRow {
  layout: string;
  mover: string;
  arm: string;
  game: number;
  at: number;
  label: Label;
  gap: number;
  spread: number | null;
  approx: string | null;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN;
};
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const pct = (x: number, n: number) => (n ? `${((100 * x) / n).toFixed(1)}% (${x}/${n})` : '-');

/** The comparison tables for a set of games (every arm against B on the same layout, mover, game and decision). */
function tables(title: string, games: GameRow[], decisions: DecisionRow[]) {
  const key = (r: { layout: string; mover: string; game: number }) => `${r.layout}/${r.mover}/${r.game}`;
  const ref = new Map(decisions.filter((d) => d.arm === 'B').map((d) => [`${key(d)}/${d.at}`, d]));
  const refAcc = new Map(games.filter((g) => g.arm === 'B').map((g) => [key(g), g.acc]));
  const arms = [...new Set(games.map((g) => g.arm))].sort((x, y) => (x === 'B' ? -1 : y === 'B' ? 1 : x.localeCompare(y)));
  md(`### ${title}: ${new Set(games.map(key)).size} games (B = full review at 128)`);
  md('');
  md('| arm | decisions | first key (median s) | first mistake (median s) | total (s) | playouts | agree all | agree key | mean abs Δacc (pts) | net skips | race Best | race-Best spread vs B |');
  md('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const arm of arms) {
    const gs = games.filter((g) => g.arm === arm);
    const ds = decisions.filter((d) => d.arm === arm);
    let n = 0, same = 0, keyN = 0, keySame = 0, skips = 0, raceBest = 0, sArm = 0, sRef = 0;
    for (const d of ds) {
      const b = ref.get(`${key(d)}/${d.at}`);
      if (!b) continue;
      n++;
      if (d.label === b.label) same++;
      if (KEY.has(d.label) || KEY.has(b.label)) {
        keyN++;
        if (d.label === b.label) keySame++;
      }
      if (d.approx === 'net') skips++;
      if (d.approx === 'race' && d.spread !== null && b.spread !== null) {
        raceBest++;
        sArm += d.spread;
        sRef += b.spread;
      }
    }
    const dAcc = gs.map((g) => (g.acc !== null && refAcc.get(key(g)) != null ? Math.abs(100 * (g.acc - refAcc.get(key(g))!)) : NaN)).filter(Number.isFinite);
    const firstKey = gs.map((g) => g.firstKeyMs).filter((x): x is number => x !== null);
    const firstMistake = gs.map((g) => g.firstMistakeMs).filter((x): x is number => x !== null);
    const total = gs.reduce((s, g) => s + g.ms, 0) / 1000;
    const playouts = gs.reduce((s, g) => s + g.playouts, 0);
    const meanD = dAcc.reduce((s, x) => s + x, 0) / Math.max(1, dAcc.length);
    console.log('SPEED ' + JSON.stringify({ title, arm, games: gs.length, decisions: n, firstKeyS: median(firstKey) / 1000, firstMistakeS: median(firstMistake) / 1000, totalS: total, playouts, agree: same / Math.max(1, n), keySame, keyN, meanAbsDAcc: meanD, netSkips: skips, raceBest, raceBestSpreadRatio: sRef ? sArm / sRef : null }));
    md(`| ${arm} | ${n} | ${f1(median(firstKey) / 1000)} (${firstKey.length} games) | ${f1(median(firstMistake) / 1000)} (${firstMistake.length} games) | ${f1(total)} | ${playouts} | ${pct(same, n)} | ${pct(keySame, keyN)} | ${meanD.toFixed(2)} | ${pct(skips, n)} | ${pct(raceBest, n)} | ${sRef ? (sArm / sRef).toFixed(3) : '-'} |`);
  }
  md('');
}

function readJsonl<T>(dirs: string[], name: string): T[] {
  const out: T[] = [];
  const walk = (p: string) => {
    if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
    else if (p.endsWith(name)) for (const line of readFileSync(p, 'utf8').split('\n')) if (line.trim()) out.push(JSON.parse(line) as T);
  };
  dirs.forEach(walk);
  return out;
}

if (task === 'report') {
  const dirs = argv.filter((x, i) => !x.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  const games = readJsonl<GameRow>(dirs, 'games.jsonl');
  const decisions = readJsonl<DecisionRow>(dirs, 'decisions.jsonl');
  const layouts = [...new Set(games.map((g) => g.layout))].sort();
  for (const layout of layouts) {
    tables(`${layout}, every mover`, games.filter((g) => g.layout === layout), decisions.filter((d) => d.layout === layout));
    for (const mover of [...new Set(games.filter((g) => g.layout === layout).map((g) => g.mover))].sort())
      tables(`${layout} ${mover}`, games.filter((g) => g.layout === layout && g.mover === mover), decisions.filter((d) => d.layout === layout && d.mover === mover));
  }
} else {
  const layout = a.layout ?? '2p';
  const mover = (a.mover ?? 'hard') as BotLevel | 'first';
  const from = Number(a.from ?? (task === 'tune' ? 1 : 101));
  const ngames = Number(a.games ?? (task === 'tune' ? 8 : 10));
  const arms = [...new Set(['B', ...(a.arms ?? 'CE').toUpperCase().split('')])];
  const skip = Number(a.skip ?? (SKIP_BELOW || 1));
  const root = new URL('../../../', import.meta.url);
  const wasm = readFileSync(new URL('src/engine/ai/ludo_wasm.wasm', root));
  // The net the app ships (#98): extreme-net.bin, Float32.
  const net = new Uint8Array(readFileSync(new URL('src/engine/ai/extreme-net.bin', root)));
  const engine = await RolloutEngine.create(wasm, net, PLAYOUT_RULES);
  if (!engine.hasFast) throw new Error('this ludo_wasm.wasm has no review_fast: build it with wasm.yml');
  const ARMS: Record<string, { base: number; opts: ReviewOptions }> = {
    A: { base: 256, opts: { fast: false } },
    B: { base: 128, opts: { fast: false } },
    C: { base: 128, opts: { skipBelow: 0 } },
    F: { base: 128, opts: { skipBelow: 0, raceZ: 2.7 } },
    D: { base: 128, opts: { skipBelow: skip, order: 'stakes' } },
    E: { base: 128, opts: { skipBelow: 0, order: 'stakes' } },
  };

  /** One game: seat 0's person plays at `mover` ("first": always the first legal move), everyone else at Hard; the app's dice (as review_calib). */
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

  /**
   * Reviews a game with one arm, counting the playouts the engine makes. It keeps the last decision's
   * playouts (the wasm's cache), so a top-up of the same decision and seed makes only the new ones.
   */
  const run = async (rec: GameRecord, states: GameState[], arm: string) => {
    let playouts = 0;
    let last: { s: GameState; seed: number; has: number[] } | null = null;
    const reviewer: Reviewer = async (s, n, seed, ask) => {
      const v = engine.reviewFast(s, n, seed, ask);
      if (ask?.mode === 'screen' || v.mean.length < 2) return v;
      const have = last && last.s === s && last.seed === seed ? last.has : v.mean.map(() => 0);
      const now = v.count ?? v.mean.map((_, c) => Math.max(n, have[c] ?? 0));
      playouts += now.reduce((t, k, c) => t + Math.max(0, k - (have[c] ?? 0)), 0);
      last = { s, seed, has: now.map((k, c) => Math.max(k, have[c] ?? 0)) };
      return v;
    };
    const t0 = performance.now();
    const first: { key: number | null; mistake: number | null } = { key: null, mistake: null };
    const moves = await reviewMoves(rec, states, [0], reviewer, (m) => {
      if (first.key === null && KEY.has(m.label)) first.key = performance.now() - t0;
      if (first.mistake === null && MISTAKE.has(m.label)) first.mistake = performance.now() - t0;
    }, ARMS[arm]!.base, undefined, ARMS[arm]!.opts);
    return { moves, ms: performance.now() - t0, firstKeyMs: first.key, firstMistakeMs: first.mistake, playouts };
  };

  if (task === 'tune') {
    const rows: { spread: number; label: Label; full: number }[] = [];
    writeFileSync('tune.jsonl', '');
    for (let g = 0; g < ngames; g++) {
      const rec = game(from + g);
      const r = replay(rec);
      if (!r.ok) throw new Error(`game ${from + g} does not replay: ${r.error}`);
      const b = await run(rec, r.states, 'B');
      for (const m of b.moves) {
        const sc = engine.reviewFast(r.states[m.at]!, 0, 0, { mode: 'screen' });
        const spread = 100 * Math.max(...sc.gap);
        rows.push({ spread, label: m.label, full: spreadOf(m) });
        appendFileSync('tune.jsonl', JSON.stringify({ layout, mover, game: from + g, at: m.at, net: +spread.toFixed(2), label: m.label, spread: m.gaps ? spreadOf(m) : null }) + '\n');
      }
    }
    md(`### Net skip tuning: ${layout} ${mover}, seeds ${from}..${from + ngames - 1}, ${rows.length} decisions`);
    md('');
    md('| net spread under | skipped | B not Best | B key (inacc.+) | B mistake+ | B meaningful (spread ≥ 3) |');
    md('|---|---|---|---|---|---|');
    for (const t of [0.5, 1, 1.5, 2, 3, 4, 5]) {
      const sk = rows.filter((x) => x.spread < t);
      md(`| ${t} | ${pct(sk.length, rows.length)} | ${sk.filter((x) => x.label !== 'best').length} | ${sk.filter((x) => KEY.has(x.label)).length} | ${sk.filter((x) => MISTAKE.has(x.label)).length} | ${sk.filter((x) => x.full >= MEANINGFUL).length} |`);
    }
    md('');
  } else {
    writeFileSync('games.jsonl', '');
    writeFileSync('decisions.jsonl', '');
    const games: GameRow[] = [];
    const decisions: DecisionRow[] = [];
    for (let g = 0; g < ngames; g++) {
      const rec = game(from + g);
      const r = replay(rec);
      if (!r.ok) throw new Error(`game ${from + g} does not replay: ${r.error}`);
      for (const arm of arms) {
        const x = await run(rec, r.states, arm);
        const acc = accuracyOf(x.moves);
        const row: GameRow = { layout, mover, arm, game: from + g, ms: Math.round(x.ms), firstKeyMs: x.firstKeyMs && Math.round(x.firstKeyMs), firstMistakeMs: x.firstMistakeMs && Math.round(x.firstMistakeMs), playouts: x.playouts, acc: Number.isFinite(acc) ? acc : null };
        games.push(row);
        appendFileSync('games.jsonl', JSON.stringify(row) + '\n');
        for (const m of x.moves) {
          const d: DecisionRow = { layout, mover, arm, game: from + g, at: m.at, label: m.label, gap: +m.gap.toFixed(2), spread: m.gaps ? spreadOf(m) : null, approx: m.approx ?? null };
          decisions.push(d);
          appendFileSync('decisions.jsonl', JSON.stringify(d) + '\n');
        }
      }
    }
    tables(`${layout} ${mover}, seeds ${from}..${from + ngames - 1}`, games, decisions);
  }
}
