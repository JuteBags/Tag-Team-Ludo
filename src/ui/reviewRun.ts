// Runs a game's review (#65) in the worker, a decision at a time, picking up from what's already stored:
// moves reviewed earlier aren't redone, and a review from another label version starts over.
import { replay, type GameRecord, type GameState } from '../engine';
import { REVIEW_VERSION, reviewMoves, type MoveReview, type Reviewer, type RollLuck } from '../engine/ai/review';
import { workerLuck, workerReviewer } from '../engine/ai/review-worker';
import { saveReview, type StoredReview } from './store';

export interface ReviewProgress {
  moves: MoveReview[];
  luck: RollLuck[] | null;
  done: number;
  total: number;
  finished: boolean;
}

/** The owners whose moves are reviewed: the people (bots aren't). */
export const peopleOf = (rec: GameRecord) => [...new Set(rec.seats.filter((s) => !s.bot).map((s) => s.owner))];

/** How many of the people's decisions a review covers (real choices only), for the progress bar. */
export function decisionsToReview(rec: GameRecord, states: GameState[]): number {
  const who = peopleOf(rec);
  return states.filter((s, i) => i + 1 < states.length && s.phase === 'move' && who.includes(s.players[s.current]!.owner) && s.moves.length > 1).length;
}

/**
 * Reviews `rec`, reporting each new verdict through `onUpdate`. `stored` is what an earlier run kept. `store`
 * says whether to keep the result with the past game (not for a game opened from a link). Returns a stop
 * function: leaving the screen stops the review after the decision in progress.
 */
export function runReview(rec: GameRecord, stored: StoredReview | undefined, onUpdate: (p: ReviewProgress) => void, store = true, reviewer: Reviewer | null = workerReviewer()): () => void {
  let stopped = false;
  const r = replay(rec);
  const states = r.states;
  const prior = stored?.v === REVIEW_VERSION ? stored : undefined;
  const moves = [...(prior?.moves ?? [])];
  let luck: RollLuck[] | null = prior?.luck ?? null;
  const total = decisionsToReview(rec, states);
  const report = (finished: boolean) => onUpdate({ moves: [...moves].sort((a, b) => a.at - b.at), luck, done: moves.length, total, finished });
  const keep = () => (store ? saveReview(rec, { v: REVIEW_VERSION, moves, luck }) : Promise.resolve());
  report(moves.length >= total && luck !== null);
  if (!reviewer) return () => {};
  void (async () => {
    if (!luck) {
      luck = (await workerLuck(rec)?.catch(() => null)) ?? null;
      if (stopped) return;
      report(false);
      void keep();
    }
    const done = new Set(moves.map((m) => m.at));
    // Only the decisions not reviewed yet; the reviewer is skipped (and the call aborted) once stopped.
    const skip: Reviewer = async (s, n, seed) => {
      if (stopped) throw new Error('stopped');
      return reviewer(s, n, seed);
    };
    const rest = states.map((s, i) => (done.has(i) ? { ...s, moves: s.moves.slice(0, 1) } : s));
    try {
      await reviewMoves(rec, rest, peopleOf(rec), skip, (m) => {
        moves.push(m);
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
