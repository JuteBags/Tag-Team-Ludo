// Reviews one crafted position (tools/ai/positions/*.json, #97) deeply, to check a review verdict: every legal
// move's win chance by the full review (sim-rs rollout.rs review: n paired playouts for every distinct move,
// no early stop) at `--deep` playouts (default 4,096) and at the shipped 128, and the label the app's own
// review path gives the played move (review.ts reviewMoves: the race, then the full review with its top-ups)
// at the shipped 128. The game's own seed is gone with its record, so the 128 runs use `--seeds` seeds each
// and show how often each label comes up.
//   node tools/ai/dist/review_position.mjs tools/ai/positions/move87.json [--deep 4096] [--seeds 20]
// .github/workflows/review-position.yml runs it (heavy: never on the laptop).
import { appendFileSync, readFileSync } from 'node:fs';
import { createGame, trayMoves, type Color, type GameRecord, type GameState, type Move, type Seat } from '../../src/engine';
import { PLAYOUT_RULES } from '../../src/engine/ai/playout-rules';
import { labelOf, layoutKey, PLAYOUTS, reviewMoves, type DecisionValues, type Label, type Reviewer } from '../../src/engine/ai/review';
import { RolloutEngine } from '../../src/engine/ai/rollout';
import { flags } from './common';

const argv = process.argv.slice(2);
const a = flags(argv);
const file = argv.find((x, i) => !x.startsWith('--') && !argv[i - 1]?.startsWith('--')) ?? 'tools/ai/positions/move87.json';
const deep = Number(a.deep ?? 4096);
const seeds = Number(a.seeds ?? 20);
const root = new URL('../../../', import.meta.url);
const summary = process.env.GITHUB_STEP_SUMMARY;
const md = (line: string) => {
  console.log(line);
  if (summary) appendFileSync(summary, line + '\n');
};

interface Position {
  about?: string;
  seats: Seat[];
  tokens: Record<string, number[]>;
  current: Color;
  tray: number[];
  played: { token: number; from: number; to: number };
  best?: { token: number; from: number; to: number };
}
const p = JSON.parse(readFileSync(file, 'utf8')) as Position;

// The position as a 'move' state: the tokens, the mover and the tray decide it (Ludo has no hidden history).
const g = createGame(p.seats, p.current);
const players = g.players.map((pl) => ({ ...pl, tokens: [...p.tokens[pl.color]!] }));
const state: GameState = { ...g, players, current: players.findIndex((x) => x.color === p.current), phase: 'move', dice: p.tray.at(-1)!, rolls: [...p.tray], sixes: 0, moves: trayMoves(players, p.current, p.tray), event: null };
const isMove = (m: Move, x: { token: number; from: number; to: number }) => m.tokens.length === 1 && m.tokens[0] === x.token && m.from === x.from && m.to === x.to;
const played = state.moves.findIndex((m) => isMove(m, p.played));
if (played < 0) throw new Error('the played move is not legal here');
const layout = layoutKey(state);
const owner = players[state.current]!.owner;
const name = (m: Move) => `${m.tokens.length > 1 ? 'pair ' + m.tokens.join('+') : 'token ' + m.tokens[0]} ${m.from} → ${m.to} (die ${m.roll})`;

const engine = await RolloutEngine.create(readFileSync(new URL('src/engine/ai/ludo_wasm.wasm', root)), new Uint8Array(readFileSync(new URL('src/engine/ai/extreme-net.bin', root))), PLAYOUT_RULES);
if (engine.movesLen(state) !== state.moves.length) throw new Error('the engine sees other moves than the app');

/** Each move's row from a full review: chance, gap below the best and its standard error (points), label. */
const rows = (v: DecisionValues) =>
  state.moves.map((m, i) => {
    const c = v.ofMove[i]!;
    const gap = c === v.best ? 0 : 100 * v.gap[c]!;
    const se = c === v.best ? 0 : 100 * v.se[c]!;
    return { move: name(m), chance: 100 * v.mean[c]!, gap, se, label: (c === v.best ? 'best' : labelOf(gap, se, layout)) as Label };
  });

md(`## Deep review of ${file.split('/').pop()}`);
md('');
if (p.about) md(`> ${p.about}`);
md('');
md(`Layout ${layout}; ${p.current} to move, tray [${p.tray.join(', ')}]; ${state.moves.length} legal moves. Played: **${name(state.moves[played]!)}**${p.best ? `; expected best: **${name(state.moves.find((m) => isMove(m, p.best!))!)}**` : ''}.`);
md('');

// 1. The full review at `deep` playouts per move (two seeds, to show the noise is small).
const t0 = performance.now();
const deepRuns = [1, 2].map((seed) => rows(engine.review(state, deep, seed)));
md(`### Full review, ${deep} paired playouts per move (seeds 1 and 2; ${((performance.now() - t0) / 1000).toFixed(0)} s)`);
md('');
md('| move | win % (seed 1) | gap below best (pts) | ± se (pts) | label | win % (seed 2) | label (seed 2) |');
md('|---|---:|---:|---:|---|---:|---|');
deepRuns[0]!.forEach((r, i) => {
  const r2 = deepRuns[1]![i]!;
  md(`| ${r.move}${i === played ? ' (played)' : ''} | ${r.chance.toFixed(2)} | ${r.gap.toFixed(2)} | ${r.se.toFixed(2)} | ${r.label} | ${r2.chance.toFixed(2)} | ${r2.label} |`);
});
md('');

// 2. The full review at the shipped 128, over `seeds` seeds: how often each label comes up per move.
const shipped = Array.from({ length: seeds }, (_, k) => rows(engine.review(state, PLAYOUTS, 1000 + k)));
md(`### Full review at the shipped ${PLAYOUTS} playouts, ${seeds} seeds`);
md('');
md('| move | mean win % | mean gap (pts) | mean se (pts) | labels over the seeds |');
md('|---|---:|---:|---:|---|');
const tally = (ls: Label[]) =>
  Object.entries(ls.reduce<Record<string, number>>((t, l) => ((t[l] = (t[l] ?? 0) + 1), t), {}))
    .map(([l, n]) => `${l} ${n}`)
    .join(', ');
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
state.moves.forEach((m, i) => {
  const rs = shipped.map((r) => r[i]!);
  md(`| ${name(m)}${i === played ? ' (played)' : ''} | ${mean(rs.map((r) => r.chance)).toFixed(2)} | ${mean(rs.map((r) => r.gap)).toFixed(2)} | ${mean(rs.map((r) => r.se)).toFixed(2)} | ${tally(rs.map((r) => r.label))} |`);
});
md('');

// 3. The app's own review of the played move (the race, then the full review with top-ups), at 128.
const reviewer: Reviewer = async (s, n, seed, ask) => engine.reviewFast(s, n, seed, ask);
const next: GameState = { ...state, event: { type: 'moved', move: state.moves[played]! } as GameState['event'] };
const app: Label[] = [];
const appGap: number[] = [];
for (let k = 0; k < seeds; k++) {
  const rec: GameRecord = { v: 1, seats: p.seats, first: p.current, seed: 2000 + k, events: '' };
  const [r] = await reviewMoves(rec, [state, next], [owner], reviewer);
  app.push(r!.label);
  appGap.push(r!.gap);
}
md(`### The app's review of the played move (review.ts reviewMoves: race, then full review and top-ups), ${seeds} seeds`);
md('');
md(`Labels: ${tally(app)}. Gap below the best: mean ${mean(appGap).toFixed(2)} pts (min ${Math.min(...appGap).toFixed(2)}, max ${Math.max(...appGap).toFixed(2)}).`);
md('');

// The verdict: does the deep review agree with the shipped one on the played move?
const deepLabel = deepRuns[0]![played]!.label;
const agree = app.filter((l) => l === deepLabel).length;
md(`**Played move: ${deepLabel} at ${deep} playouts (gap ${deepRuns[0]![played]!.gap.toFixed(2)} ± ${deepRuns[0]![played]!.se.toFixed(2)} pts); the app's 128 review agrees in ${agree} of ${seeds} seeds.**`);
console.log('POSITION ' + JSON.stringify({ file, deep, deepRuns, app, appGap }));
