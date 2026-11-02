// The game review (#65): every decision a person made, against the engine's best, and the luck of every
// roll. Two separate measures, never compared with each other:
//  - Move quality comes from paired rollouts (sim-wasm review: a fixed number of playouts per distinct
//    move, Extreme's playout setup), through a `Reviewer`, so it runs in the worker in the app and can be
//    faked in tests. The label is the win chance the played move gave up against the best.
//  - Luck comes from the Extreme net alone: a roll's luck is the roller's chance after the face rolled,
//    minus the average over every face, weighted by the chances the app's dice actually gave that roll
//    (rebuilt from the game's seed; dice.ts). The chance after a face is the best play of the dice it
//    completes (a depth-1 search), or the net's value while the tray is still being rolled. Its mean is 0
//    for any value function, so it can be summed per person: the result minus the luck is the skill.
import { diceWeights } from '../dice';
import { roll } from '../game';
import type { GameRecord } from '../record';
import { mixSeed, positionKey, seeded } from '../rng';
import type { GameState } from '../types';
import type { Evaluator } from './linear';
import { ownerValues, searchValues } from './search';

/** One decision's rollout values (sim-wasm review): see sim-rs rollout.rs `Review`. */
export interface DecisionValues {
  /** The candidate each of state.moves leads to (moves reaching the same position share one). */
  ofMove: number[];
  /** Each candidate's chance of winning for the mover. */
  mean: number[];
  /** Each candidate's paired gap below the best, and that gap's standard error. */
  gap: number[];
  se: number[];
  best: number;
}

export type Reviewer = (state: GameState, n: number, seed: number) => Promise<DecisionValues>;

export type Label = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

/**
 * Win chance given up (points, 0-100) at the top of each label. Starting values (#65): to be calibrated on
 * reviewed games so that strong play reads mostly best/good and Normal's visibly worse.
 */
export const THRESHOLDS: [Label, number][] = [
  ['good', 3],
  ['inaccuracy', 7],
  ['mistake', 15],
];

/** "Best" within this many points of the top, or within one standard error of it (a coin flip isn't a mistake). */
export const BEST_WITHIN = 1.5;

/** The label for a move that gave up `gap` points (± `se`). */
export function labelOf(gap: number, se: number): Label {
  if (gap <= BEST_WITHIN || gap <= se) return 'best';
  for (const [label, top] of THRESHOLDS) if (gap < top) return label;
  return 'blunder';
}

/** Playouts per candidate, and the most a decision is topped up to when its gap sits near a label's edge. */
export const PLAYOUTS = 256;
export const PLAYOUTS_MAX = 1024;
/** How near (points) a label's edge a gap must be to get more playouts. */
const EDGE = 2;

const nearEdge = (gap: number) => [BEST_WITHIN, ...THRESHOLDS.map(([, t]) => t)].some((t) => Math.abs(gap - t) < EDGE);

export interface MoveReview {
  /** Index into the replay's states of the position the move was made in. */
  at: number;
  owner: number;
  /** The move played and the engine's best, as indexes into that position's moves. */
  played: number;
  best: number;
  /** Win chance (0-1) for the mover after the played move and after the best one. */
  playedChance: number;
  bestChance: number;
  /** Points given up (0-100), its standard error, and the label. */
  gap: number;
  se: number;
  label: Label;
}

export interface RollLuck {
  at: number;
  owner: number;
  face: number;
  /** Win chance gained or lost by this face against the average face, in points (-100..100). */
  luck: number;
}

/** A deterministic seed for one decision of one game, so a review never changes when it's run again. */
const decisionSeed = (rec: GameRecord, s: GameState) => mixSeed(rec.seed ?? 0x5eed, 'review' + positionKey(s));

/**
 * Reviews the person's decisions (owners in `who`) in a replayed game. Forced moves (one position to reach)
 * are skipped. Calls `onMove` as each decision is done, so the screen can show verdicts as they arrive.
 */
export async function reviewMoves(rec: GameRecord, states: GameState[], who: number[], reviewer: Reviewer, onMove?: (m: MoveReview, done: number, total: number) => void, base = PLAYOUTS): Promise<MoveReview[]> {
  const todo: number[] = [];
  for (let i = 0; i + 1 < states.length; i++) {
    const s = states[i]!;
    if (s.phase === 'move' && who.includes(s.players[s.current]!.owner) && s.moves.length > 1) todo.push(i);
  }
  const out: MoveReview[] = [];
  for (const i of todo) {
    const s = states[i]!;
    const next = states[i + 1]!;
    const ev = next.event;
    if (ev?.type !== 'moved') continue;
    const played = s.moves.findIndex((m) => JSON.stringify(m) === JSON.stringify(ev.move));
    let n = base;
    let v = await reviewer(s, n, decisionSeed(rec, s));
    const c = v.ofMove[played]!;
    if (v.mean.length < 2) continue; // every move reaches the same position: nothing to choose
    while (n < PLAYOUTS_MAX && c !== v.best && nearEdge(100 * v.gap[c]!)) {
      n *= 2;
      v = await reviewer(s, n, decisionSeed(rec, s));
    }
    const cp = v.ofMove[played]!;
    const gap = cp === v.best ? 0 : 100 * v.gap[cp]!;
    const se = cp === v.best ? 0 : 100 * v.se[cp]!;
    const best = v.ofMove.indexOf(v.best);
    const r: MoveReview = { at: i, owner: s.players[s.current]!.owner, played, best, playedChance: v.mean[cp]!, bestChance: v.mean[v.best]!, gap, se, label: labelOf(gap, se) };
    out.push(r);
    onMove?.(r, out.length, todo.length);
  }
  return out;
}

/** The chances each face had for this roll: the app's dice, rebuilt from the game's seed (or fair dice without one). */
export function faceChances(rec: GameRecord, s: GameState): number[] {
  const color = s.players[s.current]!.color;
  if (rec.seed === undefined) return [1, 1, 1, 1, 1, 1].map((x) => x / 6);
  return diceWeights(s.players, color, seeded(mixSeed(rec.seed, 'dice' + positionKey(s))), s.singles);
}

/** The roller's chance after `face` at `s`: the best play of the dice it completes, or the net's value mid-tray. */
function chanceAfter(net: Evaluator, s: GameState, face: number): number {
  const owner = s.players[s.current]!.owner;
  const owners = Math.max(...s.players.map((p) => p.owner)) + 1;
  const t = roll(s, () => 0, face);
  if (t.phase === 'move' && t.current === s.current) return Math.max(...searchValues(net, t, { depth: 1, chance: 0 }).map((x) => x.value));
  return ownerValues(net, t, owners)[owner]!;
}

/** The luck of every roll in the game, for everyone (`states` from replay). */
export function rollLuck(rec: GameRecord, states: GameState[], net: Evaluator): RollLuck[] {
  const out: RollLuck[] = [];
  for (let i = 0; i + 1 < states.length; i++) {
    const s = states[i]!;
    if (s.phase !== 'roll') continue;
    const next = states[i + 1]!;
    const face = next.dice;
    if (!face) continue;
    const p = faceChances(rec, s);
    const v = [1, 2, 3, 4, 5, 6].map((f) => chanceAfter(net, s, f));
    const expect = v.reduce((a, x, k) => a + x * p[k]!, 0);
    out.push({ at: i, owner: s.players[s.current]!.owner, face, luck: 100 * (v[face - 1]! - expect) });
  }
  return out;
}

/** What each label scores toward accuracy: a blunder costs more than an inaccuracy. */
export const LABEL_SCORE: Record<Label, number> = { best: 1, good: 0.9, inaccuracy: 0.6, mistake: 0.3, blunder: 0 };

/** Each person's accuracy (the mean label score of their reviewed moves, 0-1) and total luck. */
export function summary(moves: MoveReview[], luck: RollLuck[], owners: number) {
  return Array.from({ length: owners }, (_, o) => {
    const mine = moves.filter((m) => m.owner === o);
    const count = (l: Label) => mine.filter((m) => m.label === l).length;
    return {
      owner: o,
      moves: mine.length,
      accuracy: mine.length ? mine.reduce((a, m) => a + LABEL_SCORE[m.label], 0) / mine.length : NaN,
      labels: { best: count('best'), good: count('good'), inaccuracy: count('inaccuracy'), mistake: count('mistake'), blunder: count('blunder') },
      luck: luck.filter((l) => l.owner === o).reduce((a, l) => a + l.luck, 0),
    };
  });
}
