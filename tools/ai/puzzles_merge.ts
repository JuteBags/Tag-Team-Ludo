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
// --keep pool.json: keep that pool's daily bands exactly as they are (no one's daily puzzle changes) and only
// build the Expert list from the shards (pool v3).
const ki = argv.indexOf('--keep');
const keep = ki >= 0 ? (JSON.parse(readFileSync(argv[ki + 1]!, 'utf8')) as { easy: unknown[][]; medium: unknown[][]; hard: unknown[][] }) : null;
const files = argv.filter((x, i) => !x.startsWith('--') && argv[i - 1] !== '--out' && argv[i - 1] !== '--keep');
/** The start day of the Expert puzzles until the release sets it (tests/puzzles.test.ts fails on it at 3.5.0). */
const EXPERT_FROM_UNSET = '2099-01-01';
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
// Within a band, positions with 3+ candidates first (pool v2, #99: a 2-move puzzle reads like a coin flip);
// 2-move ones only fill what's left.
const candidates = (p: Puzzle) => new Set(p.gaps).size;
const byBand = Object.fromEntries(
  BANDS.map((b) => {
    const xs = shuffled(unique.filter((p) => p.band === b));
    return [b, [...xs.filter((p) => candidates(p) >= 3), ...xs.filter((p) => candidates(p) < 3)]];
  }),
) as Record<(typeof BANDS)[number], Puzzle[]>;
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
const bands = keep ? { easy: keep.easy, medium: keep.medium, hard: keep.hard } : { easy: pool.easy.map(compact), medium: pool.medium.map(compact), hard: pool.hard.map(compact) };
// A position's identity in compact form: tokens, mover, tray.
const idOf = (e: unknown[]) => JSON.stringify([e[1], e[2], e[3]]);
const daily = new Set([...bands.easy, ...bands.medium, ...bands.hard].map(idOf));
// The Expert list (#99, the owner): positions the Hard bot misses too, none of them a daily puzzle; 3+
// candidates first, at most PER_GAME per game, in a fixed shuffled order. One a day from expertFrom.
const expertGames = new Map<number, number>();
const expertAll = shuffled(unique.filter((p) => p.hardMisses && (p.layout === '2p' || p.layout === '4p') && !daily.has(idOf(compact(p)))));
const expert = [...expertAll.filter((p) => candidates(p) >= 3), ...expertAll.filter((p) => candidates(p) < 3)].filter((p) => {
  const n = expertGames.get(p.from.seed) ?? 0;
  if (n >= PER_GAME) return false;
  expertGames.set(p.from.seed, n + 1);
  return true;
});
// The pool's version: every regeneration or re-merge bumps it (a cached entry is only decoded against its own).
const POOL_VERSION = 3;
const json = JSON.stringify({ v: POOL_VERSION, ...bands, expertFrom: EXPERT_FROM_UNSET, expert: expert.map(compact) });
writeFileSync(out, json + '\n');

const count = (xs: Puzzle[], k: (p: Puzzle) => string) => JSON.stringify(xs.reduce<Record<string, number>>((t, p) => ((t[k(p)] = (t[k(p)] ?? 0) + 1), t), {}));
const raw = Buffer.byteLength(json);
const gz = gzipSync(json, { level: 9 }).length;
const n = pool.easy.length + pool.medium.length + pool.hard.length;
md(`### The puzzle pool (#99): ${files.length} shards, ${all.length} clear positions, ${unique.length} distinct`);
md('');
md('| band | available | in the pool | needed for a year | by layout | 3+ candidates | Hard bot misses it too |');
md('|---|---:|---:|---:|---|---:|---:|');
for (const b of BANDS) md(`| ${b} | ${byBand[b].length} | ${pool[b].length} | ${NEED[b]} | ${count(pool[b], (p) => p.layout)} | ${pool[b].filter((p) => candidates(p) >= 3).length} | ${pool[b].filter((p) => p.hardMisses).length} |`);
md('');
md(`- Games used: ${perGame.size}, at most ${PER_GAME} each. By pairing: ${count([...pool.easy, ...pool.medium, ...pool.hard], (p) => p.from.mix)}.`);
md(`- **Size: ${(raw / 1024).toFixed(1)} kB raw, ${(gz / 1024).toFixed(1)} kB gzip** for ${n} puzzles (${(raw / n).toFixed(0)} B and ${(gz / n).toFixed(0)} B each).`);
if (!keep) for (const b of BANDS) if (pool[b].length < NEED[b]) md(`- **Short: ${b} has ${pool[b].length} of ${NEED[b]}.** Run more games.`);
md(`- **Expert: ${expert.length}** (positions the Hard bot misses too, none a daily puzzle; ${expertAll.length} available, ${expert.filter((p) => candidates(p) >= 3).length} with 3+ candidates, ${count(expert, (p) => p.layout)}), from ${EXPERT_FROM_UNSET} until the release sets the day.${keep ? ' The daily bands are kept as they were.' : ''}`);
md('');
