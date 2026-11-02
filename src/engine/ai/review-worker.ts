// The review's rollouts in their own Web Worker (rollout-worker.ts, kind 'review'), so reviewing a game
// never competes with a bot thinking in a game. Null where workers can't run.
import type { GameState } from '../types';
import type { GameRecord } from '../record';
import type { DecisionValues, Reviewer, ReviewAsk, RollLuck } from './review';

let worker: Worker | null | undefined;
let nextId = 0;
const pending = new Map<number, { done: (v: never) => void; fail: (e: Error) => void }>();

function reviewWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./rollout-worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return (worker = null);
  }
  worker.onmessage = (e: MessageEvent<{ id: number; values?: DecisionValues; luck?: RollLuck[]; chances?: number[][]; error?: string }>) => {
    const p = pending.get(e.data.id);
    pending.delete(e.data.id);
    const v = e.data.values ?? (e.data.luck ? { luck: e.data.luck, chances: e.data.chances ?? [] } : undefined);
    if (v) p?.done(v as never);
    else p?.fail(new Error(e.data.error ?? 'review failed'));
  };
  worker.onerror = () => {
    for (const p of pending.values()) p.fail(new Error('review worker failed'));
    pending.clear();
    worker = null;
  };
  return worker;
}

/** The app's Reviewer: sim-wasm review in the worker. Null where workers can't run. */
export function workerReviewer(): Reviewer | null {
  const w = reviewWorker();
  if (!w) return null;
  return (state: GameState, n: number, seed: number, ask?: ReviewAsk) =>
    new Promise<DecisionValues>((done, fail) => {
      const id = nextId++;
      pending.set(id, { done: done as (v: never) => void, fail });
      w.postMessage({ id, kind: 'review', state, n, seed, ask });
    });
}

/** The luck of every roll in `rec` and everyone's net win chance at every state, worked out in the worker. Null where workers can't run. */
export function workerLuck(rec: GameRecord): Promise<{ luck: RollLuck[]; chances: number[][] }> | null {
  const w = reviewWorker();
  if (!w) return null;
  return new Promise<{ luck: RollLuck[]; chances: number[][] }>((done, fail) => {
    const id = nextId++;
    pending.set(id, { done: done as (v: never) => void, fail });
    w.postMessage({ id, kind: 'luck', rec });
  });
}

/** Ends the worker (the review queue calls it once it's empty), so no idle worker holds memory. */
export function stopReviewWorker() {
  if (!worker) return;
  worker.terminate();
  for (const p of pending.values()) p.fail(new Error('review worker stopped'));
  pending.clear();
  worker = undefined;
}
