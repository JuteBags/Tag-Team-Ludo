// Runs a game's review (#65, #96) in the worker, a decision at a time, picking up from what's already stored:
// moves reviewed earlier aren't redone. A review from another label version is redone, but kept to show
// (greyed, "Older review · updating…") until the new one is finished. reviewQueue.ts decides when it runs.
import { replay, type GameRecord, type GameState } from '../engine';
import { markSixRuns, REVIEW_VERSION, reviewMoves, type MoveReview, type Reviewer, type RollLuck } from '../engine/ai/review';
import { workerLuck, workerReviewer } from '../engine/ai/review-worker';
import { KEY_LABELS } from './reviewText';
import { keyOf, saveReview, type StoredReview } from './store';

export interface ReviewProgress {
  moves: MoveReview[];
  luck: RollLuck[] | null;
  /** Every owner's net win chance (whole %) at every state, for the win-chance bar; null until worked out. */
  chances: number[][] | null;
  /** The owners this review covers (people, and any bot whose side was asked for). */
  who: number[];
  done: number;
  total: number;
  finished: boolean;
  /** Seconds still to go, from this run's pace (null until a few verdicts are in). */
  eta: number | null;
  /** When the review was made, once it's finished. */
  when?: number;
  /** A review from an older label version, shown until this one is finished. */
  old?: StoredReview;
  /** The people's own decisions (bots' sides asked for on demand don't count): what "Reviewing 40%" reports. */
  mine: { done: number; total: number; finished: boolean };
  /** This run's decisions still to review when it started, biggest at stake first (#93): the screen lists them
   *  straight away with "…" until each verdict lands. Never stored: the net screen redoes it in a moment. */
  order?: number[];
  /** With `order`: the decisions found to have nothing to choose (dropped from that list). */
  skipped?: number[];
}

/** Verdicts this run must make before its pace is trusted for an estimate. */
export const ETA_AFTER = 6;
/**
 * The review's shape (#179): the share of a run's time spent once each tenth of its decisions is settled, in
 * the stakes order, luck pass included (review bench, run 41907326043: 2p and 4p, 1 to 6 workers, averaged).
 * The first tenth is cheap (the race settles the biggest decisions fast), the next four cost the most (the
 * top-ups near a cut), the second half is cheap. The time left is elapsed × (1/share − 1): measured time per
 * unit of expected work, so a device's or an engine's speed cancels out.
 */
export const ETA_CURVE = [0, 0.03, 0.19, 0.35, 0.51, 0.67, 0.79, 0.88, 0.94, 0.97, 1];
/** No estimate before this share of the run's decisions: the cheap first tenth says little about the rest. */
export const ETA_FROM = 0.25;

/** Seconds left for a run `elapsedMs` in with `share` (0-1) of its decisions settled; null before ETA_FROM. */
export function etaLeft(elapsedMs: number, share: number): number | null {
  if (!(share >= ETA_FROM)) return null;
  if (share >= 1) return 0;
  const i = Math.min(9, Math.floor(share * 10));
  const g = ETA_CURVE[i]! + (ETA_CURVE[i + 1]! - ETA_CURVE[i]!) * (share * 10 - i);
  return (elapsedMs / 1000) * (1 / g - 1);
}
/**
 * When the luck pass runs (#93): luck is one long worker call (up to 17-25 s in 4p) and the least urgent number
 * on the screen, so the key moves come first. It starts after this run's first LUCK_AFTER_KEYS key verdicts
 * (mistakes and blunders), or after LUCK_AFTER_SHARE of its decisions for a game with few or none, whichever
 * comes first; a review with nothing left to check gets it at the end.
 */
export const LUCK_AFTER_KEYS = 2;
export const LUCK_AFTER_SHARE = 1 / 3;

/** The owners whose moves are reviewed by default: the people (bots only when asked for). */
export const peopleOf = (rec: GameRecord) => [...new Set(rec.seats.filter((s) => !s.bot).map((s) => s.owner))];

/** How many of `who`'s decisions a review covers (real choices only), for the progress bar. */
export function decisionsToReview(rec: GameRecord, states: GameState[], who = peopleOf(rec)): number {
  return states.filter((s, i) => i + 1 < states.length && s.phase === 'move' && who.includes(s.players[s.current]!.owner) && s.moves.length > 1).length;
}

/**
 * Each game's newest run: a run that was stopped (paused, or overtaken by a newer run of the same game) must
 * never save over the newer one, so only the newest run of a game saves, and a stopped run drops late results.
 */
const newestRun = new Map<string, number>();
let runs = 0;

// Stored at the precision anything reads them with (points to 2 decimals, chances to 4): it halves a review's size.
const r2 = (x: number) => Math.round(100 * x) / 100;
const r4 = (x: number) => Math.round(10000 * x) / 10000;
const compactMove = (m: MoveReview): MoveReview => ({ ...m, playedChance: r4(m.playedChance), bestChance: r4(m.bestChance), gap: r2(m.gap), se: r2(m.se) });
const compactRoll = (l: RollLuck): RollLuck => ({ ...l, luck: r2(l.luck), ...(l.sd === undefined ? {} : { sd: r2(l.sd) }), ...(l.run === undefined ? {} : { run: r2(l.run) }) });

/** The review kept from an older version, if `stored` is one (or carries one). */
const olderOf = (stored: StoredReview | undefined): StoredReview | undefined =>
  !stored ? undefined : stored.v !== REVIEW_VERSION ? { v: stored.v, moves: stored.moves, luck: stored.luck, when: stored.when } : stored.old;

/**
 * Reviews `who`'s decisions in `rec`, reporting each new verdict through `onUpdate`. `stored` is what an
 * earlier run kept. `store` says whether to keep the result with the past game (not for a game opened from a
 * link). Returns a stop function: the review stops after the decision in progress, keeping what's done.
 */
export function runReview(
  rec: GameRecord,
  stored: StoredReview | undefined,
  onUpdate: (p: ReviewProgress) => void,
  store = true,
  reviewer: Reviewer | null = workerReviewer(),
  who: number[] = peopleOf(rec),
  luckOf: typeof workerLuck = workerLuck,
): () => void {
  let stopped = false;
  const gameKey = keyOf(rec);
  const me = ++runs;
  newestRun.set(gameKey, me);
  const newest = () => newestRun.get(gameKey) === me;
  const states = replay(rec).states;
  const prior = stored?.v === REVIEW_VERSION ? stored : undefined;
  const old = olderOf(stored);
  const moves = [...(prior?.moves ?? [])];
  const skipped = new Set(prior?.skip ?? []);
  let luck: RollLuck[] | null = prior?.luck ?? null;
  let chances: number[][] | null = prior?.chances ?? null;
  // Whoever a stored review already covers stays covered.
  const covered = [...new Set([...who, ...(prior?.who ?? [])])].sort((a, b) => a - b);
  const total = decisionsToReview(rec, states, covered);
  const settled = () => moves.length + skipped.size;
  const done = () => settled() >= total && luck !== null;
  let when = prior?.when;
  let order: number[] | undefined;
  // The pace of this run: when its first decision started, its decisions, and how many it has settled.
  let t0 = 0;
  let fresh = 0;
  let runSkipped = 0;
  let toCheck = 0;
  const eta = () => (fresh >= ETA_AFTER && toCheck > 0 ? etaLeft(Date.now() - t0, (fresh + runSkipped) / toCheck) : null);
  // The people's side alone, for the status shown on the result card and in Games & reviews.
  const people = peopleOf(rec);
  const mineTotal = decisionsToReview(rec, states, people);
  const ownerAt = (at: number) => states[at]!.players[states[at]!.current]!.owner;
  const mine = () => {
    const done = moves.filter((m) => people.includes(m.owner)).length + [...skipped].filter((at) => people.includes(ownerAt(at))).length;
    return { done, total: mineTotal, finished: done >= mineTotal && luck !== null };
  };
  const report = (finished: boolean) =>
    onUpdate({ moves: [...moves].sort((a, b) => a.at - b.at), luck, chances, who: covered, done: settled(), total, finished, eta: finished ? 0 : eta(), when: finished ? when : undefined, old: finished ? undefined : old, mine: mine(), ...(order && !finished ? { order, skipped: [...skipped] } : {}) });
  // Kept only when this run added something, so reopening a finished review keeps its date.
  let changed = false;
  const keep = () => {
    if (!changed || !newest()) return Promise.resolve();
    when = Date.now();
    // Sorted by position (#151): with a pool of workers, verdicts arrive out of order.
    const review: StoredReview = { v: REVIEW_VERSION, moves: [...moves].sort((a, b) => a.at - b.at).map(compactMove), luck: luck && luck.map(compactRoll), chances: chances ?? undefined, who: covered, skip: skipped.size ? [...skipped] : undefined, when, old: done() ? undefined : old, done: done() || undefined };
    return store ? saveReview(rec, review, newest) : Promise.resolve();
  };
  report(done());
  if (!reviewer || done()) return () => {};
  void (async () => {
    // A key verdict on show (from this run, or a stored one): until then, the decisions go before the luck.
    let firstKey = moves.some((m) => KEY_LABELS.includes(m.label));
    // The luck pass (one long worker call): after the first key verdicts or a share of the decisions, or at the end (#93). Once.
    let luckRun: Promise<void> | undefined;
    const luckPass = () =>
      (luckRun ??= (async () => {
        if (luck || stopped) return;
        // In chunks (#125): verdicts can go between them, and a stop lands within one.
        // Until this run's first key verdict, the decisions go first on every worker (#151).
        const r = (await luckOf(rec, () => stopped, () => !firstKey && !stopped)?.catch(() => null)) ?? null;
        if (stopped) return;
        // A cancelled run of three 6s becomes one event (#135); the worker's chunks can split a run.
        luck = r?.luck ? markSixRuns(states as GameState[], r.luck) : null;
        chances = r?.chances ?? null;
        changed = true;
        report(false);
        void keep();
      })());
    const have = new Set([...moves.map((m) => m.at), ...skipped]);
    // Only the decisions not reviewed yet; the reviewer is skipped (and the call aborted) once stopped.
    // It forwards every argument the Reviewer type has (#101 adds an optional 4th).
    const skip: Reviewer = async (...args: Parameters<Reviewer>) => {
      if (stopped) throw new Error('stopped');
      return reviewer(...args);
    };
    // This run's decisions still to check, and the verdict count after which the luck pass starts regardless.
    toCheck = Math.max(0, total - settled());
    const luckAt = Math.max(1, Math.ceil(toCheck * LUCK_AFTER_SHARE));
    let keys = 0;
    t0 = Date.now();
    const rest = states.map((s, i) => (have.has(i) ? { ...s, moves: s.moves.slice(0, 1) } : s));
    try {
      // The biggest decisions first (#101): key moves and the turning point show within seconds.
      await reviewMoves(rec, rest, covered, skip, (m) => {
        if (stopped) return; // a late verdict from a stopped run is dropped
        moves.push(m);
        fresh++;
        changed = true;
        report(false);
        if (moves.length % 5 === 0) void keep();
        // Queued in the worker behind the call in progress, ahead of the next decision's.
        if (m.label === 'mistake' || m.label === 'blunder') keys++;
        if (KEY_LABELS.includes(m.label)) firstKey = true;
        if (keys >= LUCK_AFTER_KEYS || fresh >= luckAt) void luckPass();
      }, undefined, (at) => {
        if (stopped) return;
        skipped.add(at);
        runSkipped++;
        changed = true;
        report(false);
      }, { order: 'stakes', parallel: (reviewer as { parallel?: number } | null)?.parallel ?? 1, onOrder: (o) => {
        if (stopped) return;
        order = o;
        report(false);
      } });
      // Not started yet (nothing or little left to check): the luck pass runs now.
      await luckPass();
    } catch {
      // Stopped, or the worker failed: what's done so far is kept.
    }
    if (stopped) return; // saved when it was stopped
    await keep();
    report(true);
  })();
  // Stopping saves what's done (if this is still the newest run), then drops anything that arrives later.
  return () => {
    if (stopped) return;
    void keep();
    stopped = true;
  };
}
