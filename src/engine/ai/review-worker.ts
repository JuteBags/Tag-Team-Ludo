// The review's rollouts in their own Web Worker (rollout-worker.ts, kind 'review'), so reviewing a game
// never competes with a bot thinking in a game. Null where workers can't run.
import type { GameState } from '../types';
import type { GameRecord } from '../record';
import { LUCK_CHUNK, type DecisionValues, type Reviewer, type ReviewAsk, type RollLuck } from './review';

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
  worker.onmessage = (e: MessageEvent<{ id: number; values?: DecisionValues; error?: string }>) => {
    const p = pending.get(e.data.id);
    pending.delete(e.data.id);
    if (e.data.error !== undefined) p?.fail(new Error(e.data.error));
    else p?.done((e.data.values ?? e.data) as never);
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

/** One message to the review worker, answered by its reply. */
function call<T>(w: Worker, msg: object): Promise<T> {
  return new Promise<T>((done, fail) => {
    const id = nextId++;
    pending.set(id, { done: done as (v: never) => void, fail });
    w.postMessage({ id, ...msg });
  });
}

/**
 * The luck of every roll in `rec` and everyone's net win chance at every state, worked out in the worker a
 * chunk of states at a time (#125), so a verdict can go between chunks and a stop (`stopped`, checked before
 * each chunk) lands within one chunk. Resolves null once stopped; the worker then frees the pass. Null where
 * workers can't run.
 */
export function workerLuck(rec: GameRecord, stopped: () => boolean = () => false): Promise<{ luck: RollLuck[]; chances: number[][] } | null> | null {
  const w = reviewWorker();
  if (!w) return null;
  return (async () => {
    const { run, states } = await call<{ run: number; states: number }>(w, { kind: 'luck-begin', rec });
    const luck: RollLuck[] = [];
    const chances: number[][] = [];
    try {
      for (let from = 0; from < states; from += LUCK_CHUNK) {
        if (stopped()) return null;
        const r = await call<{ luck: RollLuck[]; chances: number[][] }>(w, { kind: 'luck-chunk', run, from, to: from + LUCK_CHUNK });
        luck.push(...r.luck);
        chances.push(...r.chances);
      }
      return { luck, chances };
    } finally {
      void call(w, { kind: 'luck-end', run }).catch(() => {});
    }
  })();
}

/** Ends the worker (the review queue calls it once it's empty), so no idle worker holds memory. */
export function stopReviewWorker() {
  if (!worker) return;
  worker.terminate();
  for (const p of pending.values()) p.fail(new Error('review worker stopped'));
  pending.clear();
  worker = undefined;
}
