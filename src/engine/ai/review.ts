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
  /** Fast reviews only (#101): each candidate's playouts, and what was asked and how it ended. */
  count?: number[];
  /** 'screen': the net's values (no playouts). A race: 'net' (the net's values: its spread was under the
   *  skip, no playouts), 'best' (the played move settled as Best: the race's values, fewer playouts for
   *  dropped candidates), 'worse' or 'full' (filled up to n: review(n) exactly). */
  kind?: 'screen' | 'net' | 'full' | 'best' | 'worse';
  /** Every candidate has all n playouts (the values are review(n)'s). */
  complete?: boolean;
}

/**
 * What to ask the engine for instead of the full review (#101): the net screen, or the race for the move
 * played (an index into state.moves), which first skips the playouts when the net's spread is under `skip`
 * points.
 */
export type ReviewAsk = { mode: 'screen' } | { mode: 'race'; played: number; skip?: number };

/** One decision's values: the full review of `n` paired playouts per candidate, or with `ask` a fast one (an engine without it answers with the full review). */
export type Reviewer = (state: GameState, n: number, seed: number, ask?: ReviewAsk) => Promise<DecisionValues>;

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

/**
 * The version of the labels (thresholds, playouts and SKIP_BELOW): a cached review from another version is
 * redone. 3: a base of 128 playouts, the race and the net screen (#101).
 */
export const REVIEW_VERSION = 3;

/**
 * The net screen (#101): a decision whose candidates the net values within this many points of each other
 * (best minus worst) is labelled Best with no playouts, and is left out of accuracy (its gaps are 0). Tuned on
 * CI (review-speed.yml). It changes labels, so changing it means bumping REVIEW_VERSION.
 */
export const SKIP_BELOW = 1.5;

/** Playouts per candidate, and the most a decision is topped up to when its gap sits near a label's edge. */
export const PLAYOUTS = 128;
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
  /** Every move's points below the best (one per state.moves, 1 decimal), for the replay's ghost and "find the better move". */
  gaps?: number[];
  /**
   * How the verdict was reached when it wasn't the full review (#101). 'race': the played move settled as
   * Best in the race, so the other moves' gaps are the race's (fewer playouts for the clearly worse ones).
   * 'net': the net saw nothing at stake, so it's Best with no playouts, gaps 0 and the chances the net's.
   * Every verdict other than Best is a full review.
   */
  approx?: 'race' | 'net';
}

/** Options for reviewMoves (#101). */
export interface ReviewOptions {
  /** 'stakes': the decisions with the most at stake (the net's spread) first; otherwise in game order. */
  order?: 'stakes';
  /** False: the full review of every decision, no screen or race (for measuring). */
  fast?: boolean;
  /** The net screen's threshold in points (SKIP_BELOW); 0 turns the screen off. */
  skipBelow?: number;
}

export interface RollLuck {
  at: number;
  owner: number;
  face: number;
  /** Win chance gained or lost by this face against the average face, in points (-100..100). */
  luck: number;
  /** The spread (standard deviation, in points) of this roll's luck over the faces it could have been. */
  sd?: number;
}

/** A deterministic seed for one decision of one game, so a review never changes when it's run again. */
const decisionSeed = (rec: GameRecord, s: GameState) => mixSeed(rec.seed ?? 0x5eed, 'review' + positionKey(s));

/**
 * Reviews the person's decisions (owners in `who`) in a replayed game. Forced moves (one position to reach)
 * are skipped. Calls `onMove` as each decision is done, so the screen can show verdicts as they arrive.
 *
 * Fast by default (#101), where the reviewer can be asked for it:
 *  1. the net screens every decision first: nothing at stake (spread under SKIP_BELOW) is Best, no playouts;
 *  2. a race spends playouts until the played move's verdict is settled: Best (the race's values), or not
 *     Best, and then every move is played out fully, exactly as the full review would, top-ups included.
 * So every verdict but Best is the full review's, and Best comes early only when it's clear.
 */
export async function reviewMoves(rec: GameRecord, states: GameState[], who: number[], reviewer: Reviewer, onMove?: (m: MoveReview, done: number, total: number) => void, base = PLAYOUTS, onSkip?: (at: number) => void, opts: ReviewOptions = {}): Promise<MoveReview[]> {
  const fast = opts.fast !== false;
  const skipBelow = opts.skipBelow ?? SKIP_BELOW;
  const todo: number[] = [];
  for (let i = 0; i + 1 < states.length; i++) {
    const s = states[i]!;
    if (s.phase === 'move' && who.includes(s.players[s.current]!.owner) && s.moves.length > 1) todo.push(i);
  }
  // For the stakes order, the net screen of every decision first (no seed: it plays nothing out); a reviewer
  // without it answers with something else and the order stays the game's. Otherwise the race screens.
  const screens = new Map<number, DecisionValues>();
  if (fast && opts.order === 'stakes') {
    for (const i of todo) {
      const v = await reviewer(states[i]!, 0, 0, { mode: 'screen' });
      if (v.kind !== 'screen') break;
      screens.set(i, v);
    }
  }
  // What's at stake in a decision by the net, in points (best minus worst); unknown sorts first.
  const stakes = (i: number) => {
    const v = screens.get(i);
    return v && v.gap.length > 1 ? 100 * Math.max(...v.gap) : Infinity;
  };
  if (opts.order === 'stakes') todo.sort((a, b) => stakes(b) - stakes(a) || a - b);
  const out: MoveReview[] = [];
  for (const i of todo) {
    const s = states[i]!;
    const next = states[i + 1]!;
    const ev = next.event;
    if (ev?.type !== 'moved') continue;
    const played = s.moves.findIndex((m) => JSON.stringify(m) === JSON.stringify(ev.move));
    const owner = s.players[s.current]!.owner;
    // Nothing at stake by the net: Best with no playouts (from the stakes pass, or the race's own screen).
    const netBest = (sv: DecisionValues) => {
      const chance = sv.mean[sv.ofMove[played]!]!;
      const r: MoveReview = { at: i, owner, played, best: played, playedChance: chance, bestChance: chance, gap: 0, se: 0, label: 'best', gaps: s.moves.map(() => 0), approx: 'net' };
      out.push(r);
      onMove?.(r, out.length, todo.length);
    };
    const sv = screens.get(i);
    if (sv && sv.mean.length < 2) {
      onSkip?.(i); // every move reaches the same position: nothing to choose
      continue;
    }
    if (sv && skipBelow > 0 && stakes(i) < skipBelow) {
      netBest(sv);
      continue;
    }
    let n = base;
    let v = await reviewer(s, n, decisionSeed(rec, s), fast ? { mode: 'race', played, skip: sv ? 0 : skipBelow } : undefined);
    const c = v.ofMove[played]!;
    if (v.mean.length < 2) {
      onSkip?.(i); // every move reaches the same position: nothing to choose
      continue;
    }
    if (v.kind === 'net') {
      netBest(v);
      continue;
    }
    const settledBest = v.kind === 'best';
    // Not settled as Best: the full review's values (the race filled up to n), topped up near an edge as always.
    while (!settledBest && n < PLAYOUTS_MAX && c !== v.best && nearEdge(100 * v.gap[c]!)) {
      n *= 2;
      v = await reviewer(s, n, decisionSeed(rec, s));
    }
    const cp = v.ofMove[played]!;
    const gap = cp === v.best ? 0 : 100 * v.gap[cp]!;
    const se = cp === v.best ? 0 : 100 * v.se[cp]!;
    const best = v.ofMove.indexOf(v.best);
    const gaps = v.ofMove.map((c) => (c === v.best ? 0 : Math.round(1000 * v.gap[c]!) / 10));
    // The race settles Best only when every rival is, even at +2 se, under BEST_WITHIN better: labelOf agrees.
    const label = settledBest ? 'best' : labelOf(gap, se);
    const r: MoveReview = { at: i, owner, played, best, playedChance: v.mean[cp]!, bestChance: v.mean[v.best]!, gap, se, label, gaps };
    if (settledBest) r.approx = 'race';
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
    const sd = Math.sqrt(v.reduce((a, x, k) => a + p[k]! * (x - expect) ** 2, 0));
    out.push({ at: i, owner: s.players[s.current]!.owner, face, luck: 100 * (v[face - 1]! - expect), sd: 100 * sd });
  }
  return out;
}

/** Every owner's win chance (whole %, from the net) at every state, for the replay's win-chance bar. */
export function netChances(rec: GameRecord, states: GameState[], net: Evaluator): number[][] {
  const owners = new Set(rec.seats.map((x) => x.owner)).size;
  return states.map((s) => [...ownerValues(net, s, owners)].map((v) => Math.round(100 * v)));
}

/** What each label scores toward accuracy: a blunder costs more than an inaccuracy. */
export const LABEL_SCORE: Record<Label, number> = { best: 1, good: 0.9, inaccuracy: 0.6, mistake: 0.3, blunder: 0 };

/** The standard normal CDF (Abramowitz and Stegun 26.2.17, error under 1e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const q = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - q : q;
}

/**
 * How lucky an owner's dice were, as a percentile (0-100, 50 is average): the chance that dice rolled the
 * same way would have done worse for them. Each roll's luck has mean 0 and spread `sd`, so the total is
 * close to normal with the summed variance. NaN without rolls (or without spreads, from an older review).
 */
export function luckPercent(luck: RollLuck[], owner: number): number {
  const mine = luck.filter((l) => l.owner === owner);
  const v = mine.reduce((a, l) => a + (l.sd ?? NaN) ** 2, 0);
  if (!mine.length || !(v > 0)) return NaN;
  return 100 * normalCdf(mine.reduce((a, l) => a + l.luck, 0) / Math.sqrt(v));
}

/** Each person's accuracy (the mean label score of their reviewed moves, 0-1), total luck and luck percentile. */
/** A decision is meaningful when its best and worst moves are at least this many points apart (#96). */
export const MEANINGFUL = 3;

/** A decision's spread: its best move minus its worst, in points (NaN for reviews without every move's gap). */
export const spreadOf = (m: MoveReview) => (m.gaps?.length ? Math.max(...m.gaps) : NaN);

/**
 * Accuracy (0-1) as agreed for #96: of everything at stake in the meaningful decisions, the share kept,
 * 1 - Σgap / Σspread, so big decisions weigh more. Reviews from before every move's gap was kept fall back
 * to the mean label score. NaN with no meaningful decision.
 */
export function accuracyOf(mine: MoveReview[]): number {
  if (mine.length && mine.every((m) => m.gaps?.length)) {
    const meaningful = mine.filter((m) => spreadOf(m) >= MEANINGFUL);
    const at = meaningful.reduce((a, m) => a + spreadOf(m), 0);
    return at > 0 ? 1 - meaningful.reduce((a, m) => a + m.gap, 0) / at : NaN;
  }
  return mine.length ? mine.reduce((a, m) => a + LABEL_SCORE[m.label], 0) / mine.length : NaN;
}

/** Each owner's accuracy, labels, key mistakes (mistakes + blunders), total luck and luck percentile. */
export function summary(moves: MoveReview[], luck: RollLuck[], owners: number) {
  return Array.from({ length: owners }, (_, o) => {
    const mine = moves.filter((m) => m.owner === o);
    const count = (l: Label) => mine.filter((m) => m.label === l).length;
    return {
      owner: o,
      moves: mine.length,
      accuracy: accuracyOf(mine),
      labels: { best: count('best'), good: count('good'), inaccuracy: count('inaccuracy'), mistake: count('mistake'), blunder: count('blunder') },
      keyMistakes: count('mistake') + count('blunder'),
      luck: luck.filter((l) => l.owner === o).reduce((a, l) => a + l.luck, 0),
      luckPct: luckPercent(luck, o),
    };
  });
}
