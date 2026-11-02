// Calibrates the game review's labels per layout (#65, tools/ai/REVIEW_CALIB.md): reviews one seat's moves in
// bot games with the app's own WebAssembly engine (RolloutEngine.review + review.ts reviewMoves), for a Hard
// a Normal and an "always the first move" mover, every other seat Hard, and prints the gaps' quantiles, the label
// rates and the accuracy, over every decision and over the meaningful ones only (spread: best minus worst
// candidate, at least 3 or 5 points).
//   node tools/ai/dist/review_calib.mjs --layout 2p [--mover hard|normal|first] [--min 600] [--games 30] [--from 1]
// Prints CALIB {layout, mover, games, moves, q, rates, acc, spread: {q, ge3: {moves, acc, q, rates}, ge5: ...},
// base128: {agree, agreeKey, ...}}: base128 reviews the same decisions from 128 playouts (with the same top-ups)
// and says how often its label matches the 256 one (agreeKey: over decisions either calls a key move), and
// how long each took. net (#93, the fast first pass): each decision labelled from the net screen alone (no
// playouts) against the rollout label: agreement, key moves (mistake or blunder) found and wrongly flagged,
// the gap error and the per-game accuracy drift (net minus rollout, accuracyOf as the app), and the time.
// Seeds are fixed (game g uses seed from+g), so a rerun gives the same table.
import { appendFileSync, readFileSync } from 'node:fs';
import { createGame, move, roll, seededDie, seeded, type BotLevel, type GameRecord, type Seat } from '../../src/engine';
import { chooseBotMove } from '../../src/engine/ai/levels';
import type { NetJSON } from '../../src/engine/ai/net';
import { PLAYOUT_RULES } from '../../src/engine/ai/playout-rules';
import { accuracyOf, LABEL_SCORE, labelOf, reviewMoves, type Label, type MoveReview } from '../../src/engine/ai/review';
import { RolloutEngine } from '../../src/engine/ai/rollout';
import { replay } from '../../src/engine/record';
import { flags, MODES } from './common';

const a = flags(process.argv.slice(2));
const layout = a.layout ?? '2p';
const minMoves = Number(a.min ?? 600);
const minGames = Number(a.games ?? 30);
const from = Number(a.from ?? 1);
// --dump file: every decision as a JSON line {layout, mover, game, at, label, gap, se, spread, n, label128}, so
// other accuracy formulas can be tried offline without another run.
const dump = a.dump as string | undefined;
// Run as tools/ai/dist/review_calib.mjs: the repo root is three folders up.
const root = new URL('../../../', import.meta.url);
const wasm = readFileSync(new URL('src/engine/ai/ludo_wasm.wasm', root));
const net = JSON.parse(readFileSync(new URL('src/engine/ai/extreme-net.json', root), 'utf8')) as NetJSON;
const engine = await RolloutEngine.create(wasm, net, PLAYOUT_RULES);
// Each decision's spread (best minus worst candidate, in points), from its last (largest) review.
const spreads = new Map<object, number>();
const reviewer = async (s: Parameters<RolloutEngine['review']>[0], n: number, seed: number) => {
  const v = await engine.review(s, n, seed);
  spreads.set(s, 100 * Math.max(0, ...v.gap));
  return v;
};
type Mover = BotLevel | 'first';

/** One game: seat 0's person plays at `mover` ("first": always the first legal move), everyone else at Hard; the app's dice. */
function game(seed: number, mover: Mover): GameRecord {
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

const quantile = (xs: number[], p: number) => {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.round((s.length - 1) * p)] ?? NaN;
};

/** Gap quantiles, label rates and accuracy (LABEL_SCORE, as the app) of a set of verdicts. */
function stats(xs: { gap: number; se: number }[]) {
  const g = xs.map((x) => x.gap);
  const labels: Label[] = xs.map((x) => labelOf(x.gap, x.se, layout.replace('-singles', '')));
  const rate = (l: Label) => +(labels.filter((x) => x === l).length / Math.max(1, labels.length)).toFixed(4);
  return {
    moves: xs.length,
    acc: +(labels.reduce((a, l) => a + LABEL_SCORE[l], 0) / Math.max(1, labels.length)).toFixed(4),
    q: { p50: quantile(g, 0.5), p75: quantile(g, 0.75), p90: quantile(g, 0.9), p95: quantile(g, 0.95) },
    rates: { best: rate('best'), good: rate('good'), inaccuracy: rate('inaccuracy'), mistake: rate('mistake'), blunder: rate('blunder') },
  };
}

const lay = layout.replace('-singles', '');
const RANK: Label[] = ['best', 'good', 'inaccuracy', 'mistake', 'blunder'];
const BIG = new Set<Label>(['mistake', 'blunder']);
/** The fast pass's net-only labels against the rollout labels (#93). */
function netReport(xs: { roll: Label; net: Label; rgap: number; ngap: number }[], accDiff: number[], tNet: number, tFull: number) {
  type X = (typeof xs)[number];
  const share = (f: (x: X) => boolean, of: (x: X) => boolean = () => true) => {
    const base = xs.filter(of);
    return { n: base.length, p: +(base.filter(f).length / Math.max(1, base.length)).toFixed(4) };
  };
  const err = xs.map((x) => Math.abs(x.ngap - x.rgap));
  const absAcc = accDiff.map(Math.abs);
  return {
    agree: share((x) => x.net === x.roll),
    within1: share((x) => Math.abs(RANK.indexOf(x.net) - RANK.indexOf(x.roll)) <= 1),
    // Of the rollouts' key moves (mistake or blunder): how many the net also calls one, and how many it calls Best or Good.
    keyFound: share((x) => BIG.has(x.net), (x) => BIG.has(x.roll)),
    keyHidden: share((x) => x.net === 'best' || x.net === 'good', (x) => BIG.has(x.roll)),
    // Of the net's key moves: how many the rollouts call Best or Good (a provisional key move that goes away).
    keyFalse: share((x) => x.roll === 'best' || x.roll === 'good', (x) => BIG.has(x.net)),
    // Best by the net, worse than Good by the rollouts.
    bestWrong: share((x) => x.roll !== 'best' && x.roll !== 'good', (x) => x.net === 'best'),
    gapErr: { p50: +quantile(err, 0.5).toFixed(2), p90: +quantile(err, 0.9).toFixed(2) },
    acc: { games: accDiff.length, mean: +(accDiff.reduce((a, d) => a + d, 0) / Math.max(1, accDiff.length)).toFixed(2), p50abs: +quantile(absAcc, 0.5).toFixed(2), p90abs: +quantile(absAcc, 0.9).toFixed(2) },
    secsNet: +(tNet / 1000).toFixed(2),
    secsFull: Math.round(tFull / 1000),
  };
}

const movers: Mover[] = a.mover ? [a.mover as Mover] : ['hard', 'normal', 'first'];
for (const mover of movers) {
  const verdicts: { gap: number; se: number; spread: number }[] = [];
  // The same decisions from a base of 128 playouts: does the label agree with the 256 one?
  let same = 0;
  let pairs = 0;
  let keySame = 0;
  let keyPairs = 0;
  let t256 = 0;
  let t128 = 0;
  const KEY = new Set<Label>(['inaccuracy', 'mistake', 'blunder']);
  // The net-only labels against the rollout ones, and each game's accuracy drift (points, net minus rollout).
  const net: { roll: Label; net: Label; rgap: number; ngap: number }[] = [];
  const accDiff: number[] = [];
  let tNet = 0;
  let games = 0;
  const t0 = Date.now();
  while (games < minGames || verdicts.length < minMoves) {
    const rec = game(from + games, mover);
    const r = replay(rec);
    if (!r.ok) throw new Error(`game ${from + games} does not replay: ${r.error}`);
    spreads.clear();
    let t = Date.now();
    const full = await reviewMoves(rec, r.states, [0], reviewer);
    t256 += Date.now() - t;
    for (const m of full) verdicts.push({ gap: m.gap, se: m.se, spread: spreads.get(r.states[m.at]!) ?? 0 });
    t = Date.now();
    const half = new Map((await reviewMoves(rec, r.states, [0], reviewer, undefined, 128)).map((m) => [m.at, m.label]));
    t128 += Date.now() - t;
    // The fast first pass (#93): the same decisions labelled from the net screen alone, as the app would.
    t = Date.now();
    const netOnly: MoveReview[] = full.map((m) => {
      const st = r.states[m.at]!;
      const v = engine.reviewFast(st, 0, 0, { mode: 'screen' });
      const gaps = st.moves.map((_, k) => 100 * v.gap[v.ofMove[k]!]!);
      const gap = gaps[m.played]!;
      return { ...m, gap, se: 0, gaps, label: labelOf(gap, 0, lay), approx: 'net' };
    });
    tNet += Date.now() - t;
    netOnly.forEach((n, k) => net.push({ roll: full[k]!.label, net: n.label, rgap: full[k]!.gap, ngap: n.gap }));
    const ra = accuracyOf(full), na = accuracyOf(netOnly);
    if (Number.isFinite(ra) && Number.isFinite(na)) accDiff.push(100 * (na - ra));
    if (dump)
      for (const [k, m] of full.entries())
        appendFileSync(dump, JSON.stringify({ layout, mover, game: from + games, at: m.at, label: m.label, gap: +m.gap.toFixed(2), se: +m.se.toFixed(2), spread: +(spreads.get(r.states[m.at]!) ?? 0).toFixed(2), n: r.states[m.at]!.moves.length, label128: half.get(m.at) ?? null, netLabel: netOnly[k]!.label, netGap: +netOnly[k]!.gap.toFixed(2) }) + '\n');
    for (const m of full) {
      const l = half.get(m.at);
      if (!l) continue;
      pairs++;
      if (l === m.label) same++;
      if (KEY.has(l) || KEY.has(m.label)) {
        keyPairs++;
        if (l === m.label) keySame++;
      }
    }
    games++;
  }
  const sp = verdicts.map((x) => x.spread);
  const out = {
    layout,
    mover,
    games,
    seeds: `${from}..${from + games - 1}`,
    secs: Math.round((Date.now() - t0) / 1000),
    ...stats(verdicts),
    spread: {
      q: { p50: quantile(sp, 0.5), p75: quantile(sp, 0.75), p90: quantile(sp, 0.9) },
      ge3: stats(verdicts.filter((x) => x.spread >= 3)),
      ge5: stats(verdicts.filter((x) => x.spread >= 5)),
    },
    base128: { agree: +(same / Math.max(1, pairs)).toFixed(4), agreeKey: +(keySame / Math.max(1, keyPairs)).toFixed(4), keyPairs, secs256: Math.round(t256 / 1000), secs128: Math.round(t128 / 1000) },
    net: netReport(net, accDiff, tNet, t256),
  };
  console.log('CALIB ' + JSON.stringify(out));
}
