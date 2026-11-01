// Time per bot move in the app's own TypeScript engine (what a phone runs in its Web Worker).
//   node bench_move.mjs --spec net:net.json:2 [--mode 4p] [--games 6] [--seed 1] [--dice fair]
// Every seat plays --spec; only real choices are timed (more than one legal move). Moves are grouped by
// game stage: opening = the first 40 decisions of a game, mid = the rest. Prints BENCH {spec, mode, per
// stage: moves, mean ms, p50, p90, max}.
import { seeded } from '../../src/engine';
import { diceRngFor, flags, peopleIn, playGame, policy, type DiceMode, type Policy } from './common';

const a = flags(process.argv.slice(2));
const spec = a.spec!;
const mode = a.mode ?? '4p';
const games = Number(a.games ?? 6);
const seed = Number(a.seed ?? 1);
const diceMode = (a.dice ?? 'fair') as DiceMode;
const base = policy(spec);
const times: Record<string, number[]> = { opening: [], mid: [] };
let decisions = 0;
const timed: Policy = (s, rng) => {
  if (s.moves.length < 2) return base(s, rng);
  const t0 = performance.now();
  const m = base(s, rng);
  times[decisions++ < 40 ? 'opening' : 'mid']!.push(performance.now() - t0);
  return m;
};
for (let g = 0; g < games; g++) {
  decisions = 0;
  const gameSeed = seed * 1_000_003 + g;
  playGame(mode, Array.from({ length: peopleIn(mode) }, () => timed), seeded(gameSeed), diceRngFor(gameSeed), g % 4, undefined, diceMode);
}
const stat = (xs: number[]) => {
  const v = [...xs].sort((x, y) => x - y);
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))] ?? NaN;
  return { moves: v.length, mean: v.reduce((s, x) => s + x, 0) / Math.max(1, v.length), p50: q(0.5), p90: q(0.9), max: v[v.length - 1] ?? NaN };
};
console.log(`BENCH ${JSON.stringify({ spec, mode, dice: diceMode, opening: stat(times.opening!), mid: stat(times.mid!) })}`);
