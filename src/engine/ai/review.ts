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
import { COLORS } from '../board';
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
 * points, and settles Best within `best` points (the layout's Best cut; BEST_WITHIN when missing) at `z`
 * standard errors (0 or missing: the engine's schedule, rollout.rs best_z).
 */
export type ReviewAsk = { mode: 'screen' } | { mode: 'race'; played: number; best?: number; skip?: number; z?: number };

/** One decision's values: the full review of `n` paired playouts per candidate, or with `ask` a fast one (an engine without it answers with the full review). */
export type Reviewer = (state: GameState, n: number, seed: number, ask?: ReviewAsk) => Promise<DecisionValues>;

export type Label = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

/**
 * The label cuts in 2p (points of win chance given up, 0-100), calibrated in tools/ai/REVIEW_CALIB.md: "best"
 * up to BEST_WITHIN (or within one standard error: a coin flip isn't a mistake), then the top of each label.
 */
export const BEST_WITHIN = 1.5;
export const THRESHOLDS: [Label, number][] = [
  ['good', 2],
  ['inaccuracy', 5],
  ['mistake', 10],
];

/**
 * Each layout's scale on the 2p cuts (REVIEW_CALIB.md): with more players a move's gaps are smaller, so the
 * same cut would be harsher. The p95 ratio of Normal's gaps on meaningful decisions, against 2p. 2h-side
 * uses 2h-opposite's; doubles-off games use their layout's. Every row but 2p is provisional (wide
 * bootstrap intervals): see tools/ai/REVIEW_CALIB.md.
 */
export const THRESHOLDS_BY_LAYOUT: Record<string, number> = { '2p': 1, '3p': 0.85, '4p': 0.85, '2h-opposite': 0.65, '2h-side': 0.65 };

/** No scaled cut goes under this many points. */
const CUT_FLOOR = 1;

/** A game's layout, as the calibration names it: "2p", "3p", "4p", "2h-opposite" or "2h-side" (two houses each). */
export function layoutKey(s: GameState): string {
  const owners = new Set(s.players.map((p) => p.owner)).size;
  if (s.players.length === owners) return `${owners}p`;
  // Colours two apart in COLORS face each other across the board (as store.ts layoutOf).
  const mine = s.players.filter((p) => p.owner === s.players[0]!.owner).map((p) => COLORS.indexOf(p.color));
  return Math.abs(mine[0]! - mine[1]!) === 2 ? '2h-opposite' : '2h-side';
}

/** The cuts for a layout: the 2p ones scaled by THRESHOLDS_BY_LAYOUT (1 for a layout not in it), none under CUT_FLOOR. */
export function cutsFor(layout = '2p'): { best: number; tops: [Label, number][] } {
  const f = THRESHOLDS_BY_LAYOUT[layout] ?? 1;
  const cut = (x: number) => Math.max(CUT_FLOOR, x * f);
  return { best: cut(BEST_WITHIN), tops: THRESHOLDS.map(([l, t]) => [l, cut(t)]) };
}

/** The label for a move that gave up `gap` points (± `se`) in a game of `layout` (layoutKey). */
export function labelOf(gap: number, se: number, layout = '2p'): Label {
  const c = cutsFor(layout);
  if (gap <= c.best || gap <= se) return 'best';
  for (const [label, top] of c.tops) if (gap < top) return label;
  return 'blunder';
}

/**
 * The version of the labels (thresholds, playouts and SKIP_BELOW): a cached review from another version is
 * redone. 3: a base of 128 playouts, the race and the net screen (#101). Not bumped for the Float32 net (#98):
 * on CI it changed no label (7,368/7,368) and accuracy by at most 5e-7 points. A net change that does change
 * labels must still bump it.
 */
export const REVIEW_VERSION = 3;

/**
 * The net screen (#101): a decision whose candidates the net values within this many points of each other
 * (best minus worst) is labelled Best with no playouts, and is left out of accuracy (its gaps are 0). It
 * changes labels, so changing it means bumping REVIEW_VERSION. Off (0): on CI (review-speed.yml run 1) even
 * a 0.5-point net spread hid real inaccuracies and mistakes in 2p, and 1.5 cut key-move agreement to 83%.
 * The net still orders the decisions for order 'stakes'.
 */
export const SKIP_BELOW = 0;

/** Playouts per candidate, and the most a decision is topped up to when its gap sits near a label's edge. */
export const PLAYOUTS = 128;
export const PLAYOUTS_MAX = 1024;
/** How near (points) a label's edge a gap must be to get more playouts. */
const EDGE = 2;

const nearEdge = (gap: number, layout = '2p') => {
  const c = cutsFor(layout);
  return [c.best, ...c.tops.map(([, t]) => t)].some((t) => Math.abs(gap - t) < EDGE);
};

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
  /** The race's bound for settling Best, in standard errors at every look (for measuring); the engine's schedule by default. */
  raceZ?: number;
  /** Called once with the decisions (state indexes) in the order they'll be reviewed: the stakes order when the
   *  net screened them (#93: the review screen lists them all straight away, "…" until each verdict lands). */
  onOrder?: (order: number[]) => void;
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
 *  2. a race spends playouts until the played move's verdict is settled: Best (the race's values, unless
 *     its spread is near MEANINGFUL: see SPREAD_EXACT), or not Best, and then every move is played out
 *     fully, exactly as the full review would, top-ups included.
 * So every verdict but Best is the full review's, and Best comes early only when it's clear.
 */
export async function reviewMoves(rec: GameRecord, states: GameState[], who: number[], reviewer: Reviewer, onMove?: (m: MoveReview, done: number, total: number) => void, base = PLAYOUTS, onSkip?: (at: number) => void, opts: ReviewOptions = {}): Promise<MoveReview[]> {
  const fast = opts.fast !== false;
  const skipBelow = opts.skipBelow ?? SKIP_BELOW;
  const layout = states[0] ? layoutKey(states[0]) : '2p';
  // The race settles Best within the layout's own Best cut (labelOf's), so it never calls Best what the cuts call Good.
  const bestCut = cutsFor(layout).best;
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
  // Decisions where every move reaches the same position aren't choices: they're skipped, so not listed.
  opts.onOrder?.(todo.filter((i) => !(screens.get(i) && screens.get(i)!.mean.length < 2)));
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
    let v = await reviewer(s, n, decisionSeed(rec, s), fast ? { mode: 'race', played, best: bestCut, skip: sv ? 0 : skipBelow, ...(opts.raceZ ? { z: opts.raceZ } : {}) } : undefined);
    const c = v.ofMove[played]!;
    if (v.mean.length < 2) {
      onSkip?.(i); // every move reaches the same position: nothing to choose
      continue;
    }
    if (v.kind === 'net') {
      netBest(v);
      continue;
    }
    // Settled as Best, unless what's at stake is near the line that puts it in accuracy: then the full review.
    let settledBest = v.kind === 'best';
    if (settledBest) {
      const spread = 100 * Math.max(...v.gap);
      if (spread >= SPREAD_EXACT[0] && spread < SPREAD_EXACT[1]) {
        v = await reviewer(s, n, decisionSeed(rec, s));
        settledBest = false;
      }
    }
    // Not settled as Best: the full review's values (the race filled up to n), topped up near an edge as always.
    while (!settledBest && n < PLAYOUTS_MAX && c !== v.best && nearEdge(100 * v.gap[c]!, layout)) {
      n *= 2;
      v = await reviewer(s, n, decisionSeed(rec, s));
    }
    const cp = v.ofMove[played]!;
    const gap = cp === v.best ? 0 : 100 * v.gap[cp]!;
    const se = cp === v.best ? 0 : 100 * v.se[cp]!;
    const best = v.ofMove.indexOf(v.best);
    const gaps = v.ofMove.map((c) => (c === v.best ? 0 : Math.round(1000 * v.gap[c]!) / 10));
    // The race settles Best only when every rival is, even at +z se, under the layout's Best cut better: labelOf agrees.
    const label = settledBest ? 'best' : labelOf(gap, se, layout);
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

/** The roller's chance after each face 1..6 at a roll state, from `net` (the WebAssembly engine gives the same values, #125). */
export const faceValues = (net: Evaluator, s: GameState): number[] => [1, 2, 3, 4, 5, 6].map((f) => chanceAfter(net, s, f));

/** States per chunk of the luck pass (luck.ts, #125): a few tens of milliseconds, so a stop lands well within 200 ms. */
export const LUCK_CHUNK = 64;

/** Whether states[i] is a roll the luck pass judges: a roll state, followed by the roll. */
export const isJudgedRoll = (states: GameState[], i: number): boolean => states[i]!.phase === 'roll' && i + 1 < states.length && !!states[i + 1]!.dice;

/** The luck of the roll at states[i] (isJudgedRoll), from the roller's chance after each face (`v`, faces 1..6). */
export function luckFrom(rec: GameRecord, states: GameState[], i: number, v: number[]): RollLuck {
  const s = states[i]!;
  const face = states[i + 1]!.dice!;
  const p = faceChances(rec, s);
  const expect = v.reduce((a, x, k) => a + x * p[k]!, 0);
  const sd = Math.sqrt(v.reduce((a, x, k) => a + p[k]! * (x - expect) ** 2, 0));
  return { at: i, owner: s.players[s.current]!.owner, face, luck: 100 * (v[face - 1]! - expect), sd: 100 * sd };
}

/** The luck of every roll in the game, for everyone (`states` from replay). */
export function rollLuck(rec: GameRecord, states: GameState[], net: Evaluator): RollLuck[] {
  const out: RollLuck[] = [];
  for (let i = 0; i + 1 < states.length; i++) if (isJudgedRoll(states, i)) out.push(luckFrom(rec, states, i, faceValues(net, states[i]!)));
  return out;
}

/** How many people a record's win-chance bar shows. */
export const peopleIn = (rec: GameRecord) => new Set(rec.seats.map((x) => x.owner)).size;

/** A state's win chances as the bar shows them (whole %), from everyone's chance (ownerValues). */
export const barChances = (v: ArrayLike<number>, people: number): number[] => Array.from(v).slice(0, people).map((x) => Math.round(100 * x));

/** Every owner's win chance (whole %, from the net) at every state, for the replay's win-chance bar. */
export function netChances(rec: GameRecord, states: GameState[], net: Evaluator): number[][] {
  const owners = peopleIn(rec);
  return states.map((s) => barChances(ownerValues(net, s, owners), owners));
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

/**
 * A decision the race settled as Best whose spread (by the race) falls in this range (points) is reviewed in
 * full after all (#101): accuracy counts only decisions with a spread of MEANINGFUL or more, and near that
 * line the race's fewer playouts would move decisions in and out of it (review-speed run 2: |Δ accuracy| per
 * 4p game 0.67 against the full review, 0.25 with this). Set around MEANINGFUL, so it moves with it. The engine
 * keeps the race's playouts, so the full review only adds the rest, and its values are the full review's
 * exactly. It changes labels and values, so changing it means bumping REVIEW_VERSION.
 */
export const SPREAD_EXACT: [number, number] = [MEANINGFUL - 1, MEANINGFUL + 2];

/** A decision's spread: its best move minus its worst, in points (NaN for reviews without every move's gap). */
export const spreadOf = (m: MoveReview) => (m.gaps?.length ? Math.max(...m.gaps) : NaN);

/** The labels that always put a decision in the accuracy, whatever its spread (#133). */
const COUNTED_LABELS: ReadonlySet<Label> = new Set<Label>(['inaccuracy', 'mistake', 'blunder']);
/** The most accuracy can be when a counted move wasn't Best (#133): it rounds to 99%, never a false 100%. */
export const NOT_PERFECT = 0.99;
/**
 * The accuracy rules' version, kept in each review summary (store.ts): a summary made under other rules is
 * recomputed from the stored gaps. 2: #133 (labelled moves always count, no false 100%).
 */
export const ACCURACY_VERSION = 2;

/**
 * Accuracy (0-1) as agreed for #96: of everything at stake in the counted decisions, the share kept,
 * 1 - Σgap / Σspread, so big decisions weigh more; a Best move's gap counts as 0 (it's noise). A decision
 * counts when its spread is meaningful (MEANINGFUL) or the move is labelled Inaccuracy, Mistake or Blunder
 * (#133: a labelled move never drops out). It is 1 only when every counted move is Best; otherwise at most
 * NOT_PERFECT. Reviews from before every move's gap was kept fall back to the mean label score. NaN with no
 * counted decision.
 */
export function accuracyOf(mine: MoveReview[]): number {
  const cap = (acc: number, moves: MoveReview[]) => (moves.every((m) => m.label === 'best') ? acc : Math.min(acc, NOT_PERFECT));
  if (mine.length && mine.every((m) => m.gaps?.length)) {
    const counted = mine.filter((m) => spreadOf(m) >= MEANINGFUL || COUNTED_LABELS.has(m.label));
    const at = counted.reduce((a, m) => a + spreadOf(m), 0);
    // A move labelled Best gave up nothing: its gap is within noise, and the number agrees with the label.
    return at > 0 ? cap(1 - counted.reduce((a, m) => a + (m.label === 'best' ? 0 : m.gap), 0) / at, counted) : NaN;
  }
  return mine.length ? cap(mine.reduce((a, m) => a + LABEL_SCORE[m.label], 0) / mine.length, mine) : NaN;
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
