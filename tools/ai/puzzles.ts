// The daily puzzle's curated pool (#99): positions with one clear best move, from bot self-play, checked by
// the app's own WebAssembly engine at 1,024 paired playouts per candidate.
//   node tools/ai/dist/puzzles.mjs [--games 20] [--from 1] [--out puzzles.json]
// .github/workflows/puzzles.yml runs it (heavy: never on the laptop). The design is on #99:
//   - games: Hard vs Hard, Extreme vs Normal and Normal vs Normal (the mistakes real players make), 2p 60 %
//     and 4p 40 %, the app's dice, fixed seeds (game g uses seed from+g): a rerun gives the same pool;
//   - at each decision with 2+ candidates (distinct resulting positions), the net screen first: its spread
//     must be at least 6·f points (f: the layout's scale, THRESHOLDS_BY_LAYOUT);
//   - then the full review at 1,024 playouts: one clear Best when every other candidate is a Mistake at two
//     standard errors, min over c ≠ best of (gap_c − 2·se_c) ≥ 3·f;
//   - deduped by position (puzzles_merge.ts then takes at most 2 per game, the scarcest band first);
//   - a band: easy (the Normal bot finds it, 2nd-best gap ≥ 10·f), medium (Normal finds it with less), hard
//     (Normal misses it); one band easier with a single plausible move (within 15·f of the best);
//   - the reveal's line: from the best move to the end of the mover's next turn, Hard at every seat, picked
//     among 8 seeds as the one whose lead over the most tempting wrong move's line is the median (an example,
//     not a forecast), stored with its seed.
// Prints PUZZLES {...} with the counts, the timing and the size, and writes the puzzles to --out.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createGame, move, moveEvent, positionKey, roll, rollEvent, seeded, seededDie, type BotLevel, type GameState, type Move, type Rng, type Seat } from '../../src/engine';
import { chooseBotMove } from '../../src/engine/ai/levels';
import { Net } from '../../src/engine/ai/net';
import { decodeNet } from '../../src/engine/ai/netbin';
import { PLAYOUT_RULES } from '../../src/engine/ai/playout-rules';
import { layoutKey, THRESHOLDS_BY_LAYOUT, type DecisionValues } from '../../src/engine/ai/review';
import { RolloutEngine } from '../../src/engine/ai/rollout';
import { chooseExtreme } from '../../src/engine/ai/search';
import { flags, MODES } from './common';

const a = flags(process.argv.slice(2));
const games = Number(a.games ?? 20);
const from = Number(a.from ?? 1);
const out = (a.out as string | undefined) ?? 'puzzles.json';
// --only normal-4p: only 4p games with a Normal player (where the Hard band comes from: a top-up).
const only = a.only as string | undefined;
const PLAYOUTS = 1024;
const LINE_SEEDS = 8;

const root = new URL('../../../', import.meta.url);
const netBytes = new Uint8Array(readFileSync(new URL('src/engine/ai/extreme-net.bin', root)));
const engine = await RolloutEngine.create(readFileSync(new URL('src/engine/ai/ludo_wasm.wasm', root)), netBytes, PLAYOUT_RULES);
const extremeNet = new Net(decodeNet(netBytes));
const summary = process.env.GITHUB_STEP_SUMMARY;
const md = (line: string) => {
  console.log(line);
  if (summary) appendFileSync(summary, line + '\n');
};

/** The games: 10 in a cycle, 6 of them 2p and 4 of them 4p, over the three pairings. */
type Mix = 'hard-hard' | 'extreme-normal' | 'normal-normal';
const MIX_LEVELS: Record<Mix, [BotLevel, BotLevel]> = { 'hard-hard': ['hard', 'hard'], 'extreme-normal': ['extreme', 'normal'], 'normal-normal': ['normal', 'normal'] };
const CYCLE: [string, Mix][] = [
  ['2p', 'hard-hard'], ['2p', 'extreme-normal'], ['2p', 'normal-normal'], ['4p', 'hard-hard'], ['4p', 'extreme-normal'],
  ['2p', 'hard-hard'], ['2p', 'extreme-normal'], ['2p', 'normal-normal'], ['4p', 'normal-normal'], ['4p', 'extreme-normal'],
];

/** A bot's move at its level; Extreme with the shipped net (search depth 1, as the app without its worker). */
function botMove(s: GameState, rng: Rng, level?: BotLevel): Move {
  const lv = level ?? s.players[s.current]!.level ?? 'normal';
  if (lv === 'extreme') return chooseExtreme(extremeNet, s, rng, { depth: 1 });
  if (lv === s.players[s.current]!.level) return chooseBotMove(s, rng);
  const players = s.players.map((p, i) => (i === s.current ? { ...p, level: lv } : p));
  return chooseBotMove({ ...s, players }, rng);
}

/** Every decision of one game (the states where the mover has 2+ moves), the app's dice. */
function playGame(seed: number, layout: string, mix: Mix): { seats: Seat[]; decisions: GameState[] } {
  const [l0, l1] = MIX_LEVELS[mix];
  const seats: Seat[] = MODES[layout]!.seats().map((s, i) => ({ ...s, bot: true, level: i % 2 === 0 ? l0 : l1 }));
  const rng = seeded(seed * 31 + 7);
  let s = createGame(seats, seats[seed % seats.length]!.color, MODES[layout]!.singles);
  const decisions: GameState[] = [];
  for (let n = 0; s.phase !== 'over' && n < 20000; n++) {
    if (s.phase === 'roll') s = roll(s, () => 0, seededDie(seed, s));
    else {
      if (s.moves.length > 1) decisions.push(s);
      s = move(s, botMove(s, rng));
    }
  }
  return { seats, decisions };
}

/** A mover's standing: its tokens' progress (base 0, home 57) minus the opponents' average. */
function standing(s: GameState, owner: number): number {
  const sum = (o: (x: number) => boolean) => s.players.filter((p) => o(p.owner)).flatMap((p) => p.tokens).reduce((t, x) => t + x + 1, 0);
  const others = new Set(s.players.filter((p) => p.owner !== owner).map((p) => p.owner)).size || 1;
  return sum((o) => o === owner) - sum((o) => o !== owner) / others;
}

/** From `s` after `m`, Hard at every seat with dice from `seed`, to the end of the mover's next turn. */
function line(s: GameState, m: Move, seed: number): { events: string; end: GameState } {
  const dice = seeded(seed);
  const rng = seeded(seed ^ 0x5bd1e995);
  const mover = s.current;
  let x = move(s, m);
  let events = moveEvent(m);
  // 0: the rest of this turn (a 6 or a kill rolls again), 1: the others' turns, 2: the mover's next turn.
  let stage = 0;
  for (let n = 0; x.phase !== 'over' && n < 400; n++) {
    if (stage === 0 && x.current !== mover) stage = 1;
    if (stage === 1 && x.current === mover) stage = 2;
    if (stage === 2 && x.current !== mover) break;
    if (x.phase === 'roll') {
      x = roll(x, dice);
      events += rollEvent(x.dice!);
    } else {
      const mv = botMove(x, rng, 'hard');
      events += moveEvent(mv);
      x = move(x, mv);
    }
  }
  return { events, end: x };
}

export interface Puzzle {
  layout: string;
  seats: { color: string; owner: number }[];
  tokens: Record<string, number[]>;
  current: string;
  tray: number[];
  singles?: true;
  /** Per tray move (trayMoves order, as state.moves): points below the best (1 decimal), and its win %. */
  gaps: number[];
  chances: number[];
  best: number;
  band: 'easy' | 'medium' | 'hard';
  /** The Hard bot misses it too. */
  hardMisses: boolean;
  plausible: number;
  /** The smallest (gap − 2·se) over the other candidates, in points. */
  margin: number;
  line: { seed: number; events: string };
  /** The most tempting wrong move (the Normal bot's pick, else the 2nd best) and its line, same seed. */
  wrong: { move: number; events: string };
  from: { mix: Mix; seed: number; at: number };
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const t0 = performance.now();
let decisionsSeen = 0;
let screened = 0;
let reviewed = 0;
let reviewMs = 0;
const rejected = { candidates: 0, spread: 0, clear: 0, duplicate: 0 };
const seen = new Set<string>();
const puzzles: Puzzle[] = [];
const perCombo = new Map<string, { games: number; decisions: number; puzzles: number }>();

for (let g = 0; g < games; g++) {
  const seed = from + g;
  const cycle = only === 'normal-4p' ? CYCLE.filter(([l, m]) => l === '4p' && m !== 'hard-hard') : CYCLE;
  const [layout, mix] = cycle[g % cycle.length]!;
  const combo = `${layout} ${mix}`;
  const stat = perCombo.get(combo) ?? { games: 0, decisions: 0, puzzles: 0 };
  perCombo.set(combo, stat);
  stat.games++;
  const { seats, decisions } = playGame(seed, layout, mix);
  const found: Puzzle[] = [];
  for (const [at, s] of decisions.entries()) {
    decisionsSeen++;
    stat.decisions++;
    const f = THRESHOLDS_BY_LAYOUT[layoutKey(s)] ?? 1;
    // The net screen: cheap, and it already tells the candidates apart.
    const sc: DecisionValues = engine.reviewFast(s, PLAYOUTS, seed * 1000 + at, { mode: 'screen' });
    screened++;
    const cands = new Set(sc.ofMove).size;
    if (cands < 2) {
      rejected.candidates++;
      continue;
    }
    const means = [...new Set(sc.ofMove)].map((c) => sc.mean[c]!);
    if (100 * (Math.max(...means) - Math.min(...means)) < 6 * f) {
      rejected.spread++;
      continue;
    }
    const key = positionKey(s) + JSON.stringify(s.rolls);
    if (seen.has(key)) {
      rejected.duplicate++;
      continue;
    }
    // The full review: every candidate at PLAYOUTS paired playouts, with its standard error.
    const tr = performance.now();
    const v = engine.review(s, PLAYOUTS, seed * 1000 + at);
    reviewMs += performance.now() - tr;
    reviewed++;
    const others = [...new Set(v.ofMove)].filter((c) => c !== v.best);
    const margin = Math.min(...others.map((c) => 100 * (v.gap[c]! - 2 * v.se[c]!)));
    if (margin < 3 * f) {
      rejected.clear++;
      continue;
    }
    seen.add(key);
    const gapOf = (i: number) => (v.ofMove[i] === v.best ? 0 : 100 * v.gap[v.ofMove[i]!]!);
    const bestMove = v.ofMove.indexOf(v.best);
    const gap2 = Math.min(...others.map((c) => 100 * v.gap[c]!));
    const plausible = 1 + others.filter((c) => 100 * v.gap[c]! <= 15 * f).length;
    const rng = seeded(seed * 7919 + at);
    const same = (x: Move, y: Move) => x.roll === y.roll && x.from === y.from && x.to === y.to && x.tokens.join() === y.tokens.join();
    const pick = (lv: BotLevel) => {
      const m = botMove(s, rng, lv);
      return v.ofMove[s.moves.findIndex((x) => same(x, m))];
    };
    const normal = pick('normal');
    const hard = pick('hard');
    // Hard: the Normal bot misses it (a player's mistake); the Hard bot rarely does (1 in 38 in the smoke run).
    let band: Puzzle['band'] = normal !== v.best ? 'hard' : gap2 >= 10 * f ? 'easy' : 'medium';
    if (plausible === 1) band = band === 'hard' ? 'medium' : 'easy';
    // The most tempting wrong move: the Normal bot's, else the 2nd best.
    const wrongCand = normal !== v.best ? normal! : others.reduce((x, y) => (v.gap[y]! < v.gap[x]! ? y : x));
    const wrongMove = v.ofMove.indexOf(wrongCand);
    // The reveal's line: among LINE_SEEDS seeds, the median lead of the best line over the wrong one.
    const owner = s.players[s.current]!.owner;
    const runs = Array.from({ length: LINE_SEEDS }, (_, k) => {
      const ls = seed * 100003 + at * 17 + k;
      const b = line(s, s.moves[bestMove]!, ls);
      const w = line(s, s.moves[wrongMove]!, ls);
      return { seed: ls, b, w, lead: standing(b.end, owner) - standing(w.end, owner) };
    }).sort((x, y) => x.lead - y.lead);
    const mid = runs[Math.floor(LINE_SEEDS / 2)]!;
    found.push({
      layout: layoutKey(s),
      seats: seats.map((x) => ({ color: x.color, owner: x.owner })),
      tokens: Object.fromEntries(s.players.map((p) => [p.color, [...p.tokens]])),
      current: s.players[s.current]!.color,
      tray: [...s.rolls],
      ...(s.singles ? { singles: true as const } : {}),
      gaps: s.moves.map((_, i) => r1(gapOf(i))),
      chances: s.moves.map((_, i) => r1(100 * v.mean[v.ofMove[i]!]!)),
      best: bestMove,
      band,
      hardMisses: hard !== v.best,
      plausible,
      margin: r1(margin),
      line: { seed: mid.seed, events: mid.b.events },
      wrong: { move: wrongMove, events: mid.w.events },
      from: { mix, seed, at },
    });
  }
  // Every clear position is kept here; puzzles_merge.ts takes at most 2 per game, the scarce band first.
  stat.puzzles += found.length;
  puzzles.push(...found);
  console.log(`game ${seed} ${combo}: ${decisions.length} decisions, ${found.length} clear`);
}

const json = JSON.stringify(puzzles);
writeFileSync(out, json);
const totalMs = performance.now() - t0;
const bands = puzzles.reduce<Record<string, number>>((t, p) => ((t[p.band] = (t[p.band] ?? 0) + 1), t), {});
const raw = Buffer.byteLength(json);
const gz = gzipSync(json, { level: 9 }).length;
md(`### Puzzle pool (#99): ${games} games, ${PLAYOUTS} playouts per candidate`);
md('');
md('| layout and games | games | decisions | clear positions |');
md('|---|---:|---:|---:|');
for (const [k, x] of perCombo) md(`| ${k} | ${x.games} | ${x.decisions} | ${x.puzzles} |`);
md('');
md(`- Decisions: ${decisionsSeen}, screened ${screened}; dropped: 1 candidate ${rejected.candidates}, net spread under 6·f ${rejected.spread}, duplicate ${rejected.duplicate}; fully reviewed ${reviewed}, not one clear Best ${rejected.clear}.`);
md(`- **Clear positions: ${puzzles.length}** (${((100 * puzzles.length) / decisionsSeen).toFixed(1)} % of decisions, ${((100 * (reviewed - rejected.clear)) / Math.max(1, reviewed)).toFixed(0)} % of full reviews); bands ${JSON.stringify(bands)}.`);
md(`- Time: ${(totalMs / 1000).toFixed(0)} s in all, the full reviews ${(reviewMs / 1000).toFixed(0)} s (${(reviewMs / Math.max(1, reviewed)).toFixed(0)} ms each); **${(totalMs / 1000 / Math.max(1, puzzles.length)).toFixed(1)} s per clear position**.`);
md(`- Size: ${raw} B raw, ${gz} B gzip: **${(raw / Math.max(1, puzzles.length)).toFixed(0)} B per position raw, ${(gz / Math.max(1, puzzles.length)).toFixed(0)} B gzip** (this shard's full form; the pool is compact: puzzles_merge.ts).`);
md('');
console.log('PUZZLES ' + JSON.stringify({ games, decisionsSeen, screened, reviewed, rejected, accepted: puzzles.length, bands, totalMs, reviewMs, raw, gz }));
