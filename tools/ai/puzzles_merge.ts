// Joins the puzzle generator's shards (tools/ai/puzzles.ts, #99) into the app's pool: deduped by position,
// at most PER_GAME per game (the scarcest band first, so Hard isn't crowded out), a year's worth per band,
// in a fixed shuffled order, written compact (src/engine/puzzles.ts decodes it).
//   node tools/ai/dist/puzzles_merge.mjs puzzles-0.json puzzles-1.json ... [--out src/engine/puzzle-pool.json]
// The days: Mon–Wed Easy, Thu–Fri Medium, Sat–Sun Hard (src/engine/puzzles.ts BAND_OF_WEEKDAY), so a year
// (any 365 days) needs 157 Easy, 105 Medium and 105 Hard; each band's list is cycled by itself.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { seeded, SEATS } from '../../src/engine';
import type { Puzzle } from './puzzles';

const argv = process.argv.slice(2);
const oi = argv.indexOf('--out');
const out = oi >= 0 ? argv[oi + 1]! : 'src/engine/puzzle-pool.json';
const files = argv.filter((x, i) => !x.startsWith('--') && argv[i - 1] !== '--out');
const PER_GAME = 2;
// Any 365 days in a row hold at most 157 Mon-Wed, 105 Thu-Fri and 105 Sat-Sun days (52 weeks and a day).
const NEED = { hard: 105, medium: 105, easy: 157 } as const;
const BANDS = ['hard', 'medium', 'easy'] as const;
const summary = process.env.GITHUB_STEP_SUMMARY;
const md = (line: string) => {
  console.log(line);
  if (summary) appendFileSync(summary, line + '\n');
};

const all: Puzzle[] = files.flatMap((f) => JSON.parse(readFileSync(f, 'utf8')) as Puzzle[]);
const seen = new Set<string>();
const unique = all.filter((p) => {
  const k = JSON.stringify([p.layout, p.tokens, p.current, p.tray]);
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

// Each band shuffled with a fixed seed; then the scarcest band first, at most PER_GAME per game in all.
const rng = seeded(990099);
const shuffled = (xs: Puzzle[]) =>
  xs
    .map((p) => ({ p, k: rng() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.p);
const byBand = Object.fromEntries(BANDS.map((b) => [b, shuffled(unique.filter((p) => p.band === b))])) as Record<(typeof BANDS)[number], Puzzle[]>;
const perGame = new Map<number, number>();
const pool = Object.fromEntries(BANDS.map((b) => [b, [] as Puzzle[]])) as Record<(typeof BANDS)[number], Puzzle[]>;
for (const b of BANDS) {
  for (const p of byBand[b]) {
    if (pool[b].length >= NEED[b]) break;
    const n = perGame.get(p.from.seed) ?? 0;
    if (n >= PER_GAME) continue;
    perGame.set(p.from.seed, n + 1);
    pool[b].push(p);
  }
}

/**
 * One puzzle, compact: [layout, tokens in seat order (4 per colour), mover's seat, tray, gaps (1 decimal) per
 * tray move, win % (whole) per tray move, best, the Hard bot misses it (0/1), the line's seed, the line, the
 * wrong move, its line, no doubles (0/1)].
 */
const compact = (p: Puzzle) => {
  const colors = SEATS[p.layout === '2p' ? 2 : p.layout === '3p' ? 3 : 4];
  return [p.layout, colors.flatMap((c) => p.tokens[c]!), colors.indexOf(p.current as (typeof colors)[number]), p.tray, p.gaps, p.chances.map((c) => Math.round(c)), p.best, p.hardMisses ? 1 : 0, p.line.seed, p.line.events, p.wrong.move, p.wrong.events, p.singles ? 1 : 0];
};
for (const p of [...pool.easy, ...pool.medium, ...pool.hard]) if (p.layout !== '2p' && p.layout !== '4p') throw new Error(`layout ${p.layout}: the pool is 2p and 4p only`);
const json = JSON.stringify({ v: 1, easy: pool.easy.map(compact), medium: pool.medium.map(compact), hard: pool.hard.map(compact) });
writeFileSync(out, json + '\n');

const count = (xs: Puzzle[], k: (p: Puzzle) => string) => JSON.stringify(xs.reduce<Record<string, number>>((t, p) => ((t[k(p)] = (t[k(p)] ?? 0) + 1), t), {}));
const raw = Buffer.byteLength(json);
const gz = gzipSync(json, { level: 9 }).length;
const n = pool.easy.length + pool.medium.length + pool.hard.length;
md(`### The puzzle pool (#99): ${files.length} shards, ${all.length} clear positions, ${unique.length} distinct`);
md('');
md('| band | available | in the pool | needed for a year | by layout | Hard bot misses it too |');
md('|---|---:|---:|---:|---|---:|');
for (const b of BANDS) md(`| ${b} | ${byBand[b].length} | ${pool[b].length} | ${NEED[b]} | ${count(pool[b], (p) => p.layout)} | ${pool[b].filter((p) => p.hardMisses).length} |`);
md('');
md(`- Games used: ${perGame.size}, at most ${PER_GAME} each. By pairing: ${count([...pool.easy, ...pool.medium, ...pool.hard], (p) => p.from.mix)}.`);
md(`- **Size: ${(raw / 1024).toFixed(1)} kB raw, ${(gz / 1024).toFixed(1)} kB gzip** for ${n} puzzles (${(raw / n).toFixed(0)} B and ${(gz / n).toFixed(0)} B each).`);
for (const b of BANDS) if (pool[b].length < NEED[b]) md(`- **Short: ${b} has ${pool[b].length} of ${NEED[b]}.** Run more games.`);
md('');
