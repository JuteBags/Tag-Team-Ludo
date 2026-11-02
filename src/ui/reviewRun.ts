// Runs a game's review (#65, #96) in the worker, a decision at a time, picking up from what's already stored:
// moves reviewed earlier aren't redone. A review from another label version is redone, but kept to show
// (greyed, "Older review · updating…") until the new one is finished. reviewQueue.ts decides when it runs.
import { replay, type GameRecord, type GameState } from '../engine';
import { REVIEW_VERSION, reviewMoves, type MoveReview, type Reviewer, type RollLuck } from '../engine/ai/review';
import { workerLuck, workerReviewer } from '../engine/ai/review-worker';
import { saveReview, type StoredReview } from './store';

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
}

/** Verdicts this run must make before its pace is trusted for an estimate. */
export const ETA_AFTER = 6;

/** The owners whose moves are reviewed by default: the people (bots only when asked for). */
export const peopleOf = (rec: GameRecord) => [...new Set(rec.seats.filter((s) => !s.bot).map((s) => s.owner))];

/** How many of `who`'s decisions a review covers (real choices only), for the progress bar. */
export function decisionsToReview(rec: GameRecord, states: GameState[], who = peopleOf(rec)): number {
  return states.filter((s, i) => i + 1 < states.length && s.phase === 'move' && who.includes(s.players[s.current]!.owner) && s.moves.length > 1).length;
}

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
  const states = replay(rec).states;
  const prior = stored?.v === REVIEW_VERSION ? stored : undefined;
  const old = olderOf(stored);
  const moves = [...(prior?.moves ?? [])];
  let luck: RollLuck[] | null = prior?.luck ?? null;
  let chances: number[][] | null = prior?.chances ?? null;
  // Whoever a stored review already covers stays covered.
  const covered = [...new Set([...who, ...(prior?.who ?? [])])].sort((a, b) => a - b);
  const total = decisionsToReview(rec, states, covered);
  const done = () => moves.length >= total && luck !== null;
  let when = prior?.when;
  // The pace of this run: when its first decision started and how many it has done.
  let t0 = 0;
  let fresh = 0;
  const eta = () => (fresh >= ETA_AFTER ? ((Date.now() - t0) / 1000 / fresh) * Math.max(0, total - moves.length) : null);
  const report = (finished: boolean) =>
    onUpdate({ moves: [...moves].sort((a, b) => a.at - b.at), luck, chances, who: covered, done: moves.length, total, finished, eta: finished ? 0 : eta(), when: finished ? when : undefined, old: finished ? undefined : old });
  // Kept only when this run added something, so reopening a finished review keeps its date.
  let changed = false;
  const keep = () => {
    if (!changed) return Promise.resolve();
    when = Date.now();
    return store ? saveReview(rec, { v: REVIEW_VERSION, moves, luck, chances: chances ?? undefined, who: covered, when, old: done() ? undefined : old, done: done() || undefined }) : Promise.resolve();
  };
  report(done());
  if (!reviewer || done()) return () => {};
  void (async () => {
    if (!luck) {
      const r = (await luckOf(rec)?.catch(() => null)) ?? null;
      if (stopped) return;
      luck = r?.luck ?? null;
      chances = r?.chances ?? null;
      changed = true;
      report(false);
      void keep();
    }
    const have = new Set(moves.map((m) => m.at));
    // Only the decisions not reviewed yet; the reviewer is skipped (and the call aborted) once stopped.
    const skip: Reviewer = async (s, n, seed) => {
      if (stopped) throw new Error('stopped');
      return reviewer(s, n, seed);
    };
    t0 = Date.now();
    const rest = states.map((s, i) => (have.has(i) ? { ...s, moves: s.moves.slice(0, 1) } : s));
    try {
      await reviewMoves(rec, rest, covered, skip, (m) => {
        moves.push(m);
        fresh++;
        changed = true;
        report(false);
        if (moves.length % 5 === 0) void keep();
      });
    } catch {
      // Stopped, or the worker failed: what's done so far is kept.
    }
    await keep();
    if (!stopped) report(true);
  })();
  return () => {
    stopped = true;
  };
}
