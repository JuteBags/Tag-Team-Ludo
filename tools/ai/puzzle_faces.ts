// The roll's strip for every pool puzzle (#194): the roller's win chance after each face 1–6 with best play,
// at 1,024 playouts (src/engine/ai/faceValues.ts, the review's own scale), and each face's chance under the
// app's dice at that roll (review.ts faceChances, from the source game's seed). Each puzzle's source game is
// played again (tools/ai/puzzle_games.ts: the same seed, layout and pairing give the same game) for the state
// before the decision: a roll (re-rolling its face must give the puzzle's position exactly) gets a strip; a
// decision in the middle of a turn's dice (after another move) gets none.
//   node tools/ai/dist/puzzle_faces.mjs --pool src/engine/puzzle-pool.json shards/*.json [--shard 0 --shards 8] [--out faces-0.json]
// .github/workflows/puzzle-faces.yml runs it (heavy: never on the laptop); puzzles_merge.ts --faces writes pool v4.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { positionKey, roll, SEATS } from '../../src/engine';
import { facesByPlayouts } from '../../src/engine/ai/faceValues';
import { PLAYOUT_RULES } from '../../src/engine/ai/playout-rules';
import { faceChances } from '../../src/engine/ai/review';
import { RolloutEngine } from '../../src/engine/ai/rollout';
import { netBytes, playGame, type Mix } from './puzzle_games';
import type { Puzzle } from './puzzles';

const argv = process.argv.slice(2);
const flag = (k: string, d?: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const files = argv.filter((x, i) => !x.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const shard = Number(flag('shard', '0'));
const shards = Number(flag('shards', '1'));
const out = flag('out', 'faces.json')!;
// 1,024 as the pool's move gaps; fewer only to try the tool out.
const PLAYOUTS = Number(flag('playouts', '1024'));
const root = new URL('../../../', import.meta.url);
const engine = await RolloutEngine.create(readFileSync(new URL('src/engine/ai/ludo_wasm.wasm', root)), netBytes, PLAYOUT_RULES);
if (!engine.hasValue) throw new Error('this ludo_wasm.wasm has no value(): rebuild it (wasm.yml)');
const summary = process.env.GITHUB_STEP_SUMMARY;
const md = (line: string) => {
  console.log(line);
  if (summary) appendFileSync(summary, line + '\n');
};

// The pool's puzzles (daily bands and Expert), by identity (tokens, mover, tray: puzzles_merge.ts idOf).
type Entry = unknown[];
const pool = JSON.parse(readFileSync(flag('pool', 'src/engine/puzzle-pool.json')!, 'utf8')) as Record<string, Entry[]>;
const idOf = (e: Entry) => JSON.stringify([e[1], e[2], e[3]]);
const ids = [...new Set(['easy', 'medium', 'hard', 'expert'].flatMap((b) => (pool[b] ?? []).map(idOf)))].sort();
// Their sources, from the generator's shards.
const compactId = (p: Puzzle) => {
  const colors = SEATS[p.layout === '2p' ? 2 : 4];
  return JSON.stringify([colors.flatMap((c) => p.tokens[c]!), colors.indexOf(p.current as (typeof colors)[number]), p.tray]);
};
const source = new Map<string, Puzzle>();
for (const f of files) for (const p of JSON.parse(readFileSync(f, 'utf8')) as Puzzle[]) source.set(compactId(p), p);

const mine = ids.filter((_, i) => i % shards === shard);
const games = new Map<string, ReturnType<typeof playGame>>();
const result: Record<string, { faces: number[]; weights: number[] } | null> = {};
const r1 = (x: number) => Math.round(1000 * x) / 10;
let midTurn = 0;
const t0 = performance.now();
for (const id of mine) {
  const p = source.get(id);
  if (!p) throw new Error(`no source for pool puzzle ${id}`);
  const key = `${p.from.seed} ${p.layout} ${p.from.mix}`;
  if (!games.has(key)) games.set(key, playGame(p.from.seed, p.layout, p.from.mix as Mix));
  const g = games.get(key)!;
  const s = g.decisions[p.from.at]!;
  const pre = g.before[p.from.at]!;
  if (JSON.stringify(s.rolls) !== JSON.stringify(p.tray) || s.players[s.current]!.color !== p.current) throw new Error(`the replayed game differs at ${id}`);
  // A roll that led to this decision: re-rolling its face gives the puzzle's position exactly.
  const again = pre.phase === 'roll' && pre.current === s.current ? roll(pre, () => 0, s.dice!) : null;
  if (!again || positionKey(again) !== positionKey(s) || again.moves.length !== s.moves.length) {
    midTurn++;
    result[id] = null;
    continue;
  }
  const rec = { v: 1 as const, seats: g.seats, first: g.seats[0]!.color, seed: p.from.seed, events: '' };
  const weights = faceChances(rec, pre);
  const faces = facesByPlayouts(engine, pre, PLAYOUTS, p.from.seed * 1000 + p.from.at, { face: s.dice!, chance: p.chances[p.best]! / 100 });
  result[id] = { faces: faces.map(r1), weights: weights.map(r1) };
}
writeFileSync(out, JSON.stringify(result));
md(`- shard ${shard}/${shards}: ${mine.length} puzzles, ${mine.length - midTurn} with a strip, ${midTurn} in the middle of a turn's dice (none); ${((performance.now() - t0) / 1000).toFixed(0)} s (${((performance.now() - t0) / 1000 / Math.max(1, mine.length - midTurn)).toFixed(1)} s each)`);
