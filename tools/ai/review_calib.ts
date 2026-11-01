// Calibrates the game review's labels per layout (#65, tools/ai/REVIEW_CALIB.md): reviews one seat's moves in
// bot games with the app's own WebAssembly engine (RolloutEngine.review + review.ts reviewMoves), for a Hard
// and a Normal mover, every other seat Hard, and prints the gaps' quantiles and the label rates.
//   node tools/ai/dist/review_calib.mjs --layout 2p [--min 600] [--games 30] [--from 1]
// Prints CALIB {layout, mover, games, moves, q: {p50, p75, p90, p95}, rates: {best, good, ...}} per mover.
// Seeds are fixed (game g uses seed from+g), so a rerun gives the same table.
import { readFileSync } from 'node:fs';
import { createGame, move, roll, seededDie, seeded, type BotLevel, type GameRecord, type Seat } from '../../src/engine';
import { chooseBotMove } from '../../src/engine/ai/levels';
import type { NetJSON } from '../../src/engine/ai/net';
import { PLAYOUT_RULES } from '../../src/engine/ai/playout-rules';
import { labelOf, reviewMoves, type Label } from '../../src/engine/ai/review';
import { RolloutEngine } from '../../src/engine/ai/rollout';
import { replay } from '../../src/engine/record';
import { flags, MODES } from './common';

const a = flags(process.argv.slice(2));
const layout = a.layout ?? '2p';
const minMoves = Number(a.min ?? 600);
const minGames = Number(a.games ?? 30);
const from = Number(a.from ?? 1);
// Run as tools/ai/dist/review_calib.mjs: the repo root is three folders up.
const root = new URL('../../../', import.meta.url);
const wasm = readFileSync(new URL('src/engine/ai/ludo_wasm.wasm', root));
const net = JSON.parse(readFileSync(new URL('src/engine/ai/extreme-net.json', root), 'utf8')) as NetJSON;
const engine = await RolloutEngine.create(wasm, net, PLAYOUT_RULES);
const reviewer = async (s: Parameters<RolloutEngine['review']>[0], n: number, seed: number) => engine.review(s, n, seed);

/** One game: seat 0's person plays at `mover`, everyone else at Hard; the app's dice from the game's seed. */
function game(seed: number, mover: BotLevel): GameRecord {
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

for (const mover of ['hard', 'normal'] as BotLevel[]) {
  const gaps: { gap: number; se: number }[] = [];
  let games = 0;
  const t0 = Date.now();
  while (games < minGames || gaps.length < minMoves) {
    const rec = game(from + games, mover);
    const r = replay(rec);
    if (!r.ok) throw new Error(`game ${from + games} does not replay: ${r.error}`);
    for (const m of await reviewMoves(rec, r.states, [0], reviewer)) gaps.push({ gap: m.gap, se: m.se });
    games++;
  }
  const g = gaps.map((x) => x.gap);
  const labels: Label[] = gaps.map((x) => labelOf(x.gap, x.se));
  const rate = (l: Label) => +(labels.filter((x) => x === l).length / labels.length).toFixed(4);
  const out = {
    layout,
    mover,
    games,
    moves: gaps.length,
    seeds: `${from}..${from + games - 1}`,
    secs: Math.round((Date.now() - t0) / 1000),
    q: { p50: quantile(g, 0.5), p75: quantile(g, 0.75), p90: quantile(g, 0.9), p95: quantile(g, 0.95) },
    rates: { best: rate('best'), good: rate('good'), inaccuracy: rate('inaccuracy'), mistake: rate('mistake'), blunder: rate('blunder') },
  };
  console.log('CALIB ' + JSON.stringify(out));
}
