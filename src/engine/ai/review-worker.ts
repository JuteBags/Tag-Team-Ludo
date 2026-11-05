// The review's rollouts in Web Workers (rollout-worker.ts, kind 'review'), so reviewing a game never competes
// with a bot thinking in a game. A pool of them (#151): one core did a whole review while phones have 4-8, so
// the review's decisions and its luck pass are spread over up to MAX_POOL workers (MAX_POOL_DESKTOP on a computer), each with its own wasm
// engine. Every decision is seeded by itself and every luck chunk is independent, so a review is the same
// whatever the pool's size. Null where workers can't run.
import type { GameState } from '../types';
import type { GameRecord } from '../record';
import { LUCK_CHUNK, type DecisionValues, type Reviewer, type ReviewAsk, type RollLuck } from './review';

/** At most this many review workers on a phone or tablet: big.LITTLE has about 4 fast cores, and one is the UI's. */
export const MAX_POOL = 3;
/**
 * At most this many on a desktop or laptop: its cores are all fast, and many players review on the web build.
 * The bench's curve (review-bench.yml, #151) set it.
 */
export const MAX_POOL_DESKTOP = 6;

/** What poolSize reads of the device (navigator's fields; userAgentData is Chromium's). */
export interface PoolDevice {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  userAgentData?: { mobile?: boolean };
}

/** Whether this device's main pointer is a finger. */
const coarsePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** A phone or tablet: the browser says so (Chromium), else its main pointer is a finger (Safari, Firefox). */
export function isMobile(nav: PoolDevice | undefined, coarse = coarsePointer()): boolean {
  return nav?.userAgentData?.mobile ?? coarse;
}

/**
 * The pool's size on this device: one core fewer than it reports (the UI keeps one), at least 1, at most
 * MAX_POOL on a phone or tablet and MAX_POOL_DESKTOP elsewhere, and at most 2 with 2 GB of memory or less.
 */
export function poolSize(nav: PoolDevice | undefined = typeof navigator !== 'undefined' ? navigator : undefined, coarse = coarsePointer()): number {
  const cores = nav?.hardwareConcurrency ?? 4;
  let n = Math.max(1, Math.min(cores - 1, isMobile(nav, coarse) ? MAX_POOL : MAX_POOL_DESKTOP));
  if (nav?.deviceMemory !== undefined && nav.deviceMemory <= 2) n = Math.min(n, 2);
  return n;
}

interface Pending {
  done: (v: never) => void;
  fail: (e: Error) => void;
}
interface Slot {
  w: Worker;
  /** Calls in flight on this worker. */
  busy: number;
  pending: Map<number, Pending>;
  /** Decisions (kind 'review') in flight on this worker, and who waits for it to have none (luck's yield). */
  decisions: number;
  idle: (() => void)[];
}

/** The pool's Reviewer, and how many decisions it can take at once (review.ts ReviewOptions.parallel). */
export type PoolReviewer = Reviewer & { parallel: number };

/** One chunk of a game's luck pass: states [c·LUCK_CHUNK, (c+1)·LUCK_CHUNK). */
export interface LuckPart {
  luck: RollLuck[];
  chances: number[][];
}

/**
 * A pool of review workers, made when first asked for and ended by stop(). Calls for one decision (its race,
 * then any full review and top-ups, all with the decision's own seed) go to the worker that took it, where
 * the engine keeps that decision's playouts; anything else goes to the least busy worker.
 */
export class ReviewPool {
  private slots: Slot[] | null | undefined;
  private bySeed = new Map<number, Slot>();
  private nextId = 0;

  /** `name`: the workers' name (`wasm=plain` makes them load the plain engine build, #151). */
  constructor(readonly size: number = poolSize(), readonly name = '') {}

  private make(): Slot[] | null {
    if (this.slots !== undefined) return this.slots;
    const slots: Slot[] = [];
    for (let k = 0; k < this.size; k++) {
      let w: Worker;
      try {
        w = new Worker(new URL('./rollout-worker.ts', import.meta.url), { type: 'module', name: this.name });
      } catch {
        break;
      }
      const slot: Slot = { w, busy: 0, pending: new Map(), decisions: 0, idle: [] };
      w.onmessage = (e: MessageEvent<{ id: number; values?: DecisionValues; error?: string }>) => {
        const p = slot.pending.get(e.data.id);
        slot.pending.delete(e.data.id);
        slot.busy = slot.pending.size;
        if (e.data.error !== undefined) p?.fail(new Error(e.data.error));
        else p?.done((e.data.values ?? e.data) as never);
      };
      w.onerror = () => {
        // This worker is gone: its calls fail, and it leaves the pool (the next call uses another one).
        for (const p of slot.pending.values()) p.fail(new Error('review worker failed'));
        slot.pending.clear();
        slot.idle.splice(0).forEach((f) => f());
        w.terminate();
        this.slots = this.slots?.filter((s) => s !== slot);
        if (this.slots && !this.slots.length) this.slots = undefined;
        for (const [seed, s] of this.bySeed) if (s === slot) this.bySeed.delete(seed);
      };
      slots.push(slot);
    }
    return (this.slots = slots.length ? slots : null);
  }

  private call<T>(slot: Slot, msg: object): Promise<T> {
    return new Promise<T>((done, fail) => {
      const id = this.nextId++;
      slot.pending.set(id, { done: done as (v: never) => void, fail });
      slot.busy = slot.pending.size;
      slot.w.postMessage({ id, ...msg });
    });
  }

  /** The worker for a call: the one that has this decision (by its seed), else the least busy. */
  private pick(slots: Slot[], seed?: number): Slot {
    const had = seed === undefined ? undefined : this.bySeed.get(seed);
    if (had && slots.includes(had)) return had;
    const slot = slots.reduce((a, b) => (b.busy < a.busy ? b : a));
    if (seed !== undefined) {
      // Only recent decisions need it: a review keeps at most `size` decisions in flight.
      if (this.bySeed.size > 256) this.bySeed.clear();
      this.bySeed.set(seed, slot);
    }
    return slot;
  }

  /** The Reviewer over this pool, or null where workers can't run. */
  reviewer(): PoolReviewer | null {
    const slots = this.make();
    if (!slots) return null;
    const f = (state: GameState, n: number, seed: number, ask?: ReviewAsk) => {
      const now = this.make();
      if (!now) return Promise.reject(new Error('review workers stopped'));
      // The net screen plays nothing out and has no decision of its own (seed 0): any worker.
      const slot = this.pick(now, ask?.mode === 'screen' ? undefined : seed);
      slot.decisions++;
      const settle = () => {
        if (--slot.decisions === 0) slot.idle.splice(0).forEach((g) => g());
      };
      const r = this.call<DecisionValues>(slot, { kind: 'review', state, n, seed, ask });
      r.then(settle, settle);
      return r;
    };
    return Object.assign(f, { parallel: slots.length });
  }

  /**
   * The luck of every roll in `rec` and everyone's net win chance at every state, a chunk of states at a time
   * (#125) spread over every worker (#151). Chunks are independent (the luck cache starts afresh at each
   * roll), so the values are the same on any worker; they're put back in order. A stop (`stopped`, checked
   * before each chunk) lands within one chunk per worker; it resolves null then. Null where workers can't run.
   * While `yieldTo()` is true, a worker takes its next chunk only once it has no decision in flight: the
   * review's decisions go first (until its first key verdict, #151), and a chunk never queues ahead of one.
   * `have[c]`: chunk c already done (#176, while the game was played), not computed again.
   */
  luck(rec: GameRecord, stopped: () => boolean = () => false, yieldTo: () => boolean = () => false, have: readonly (LuckPart | undefined)[] = []): Promise<{ luck: RollLuck[]; chances: number[][] } | null> | null {
    const slots = this.make();
    if (!slots) return null;
    return (async () => {
      const passes = await Promise.all(slots.map((s) => this.call<{ run: number; states: number }>(s, { kind: 'luck-begin', rec })));
      const chunks = Math.ceil(passes[0]!.states / LUCK_CHUNK);
      // Chunks already done (#176: reviewed while the game was played) are taken as they are.
      const parts: LuckPart[] = Array.from({ length: chunks }, (_, c) => have[c]!);
      let next = 0;
      const skipDone = () => {
        while (next < chunks && parts[next]) next++;
      };
      let halted = false;
      try {
        await Promise.all(
          slots.map(async (s, k) => {
            while (next < chunks) {
              // A decision's turn: wait for this worker to finish its decisions. A macrotask after each, so
              // the review hands out its next decision (to this worker, now the least busy) before the check.
              while (yieldTo() && s.decisions > 0 && !stopped() && this.slots?.includes(s)) {
                await new Promise<void>((r) => s.idle.push(r));
                await new Promise((r) => setTimeout(r, 0));
              }
              if (stopped()) {
                halted = true;
                return;
              }
              skipDone();
              if (next >= chunks) return;
              const c = next++;
              parts[c] = await this.call(s, { kind: 'luck-chunk', run: passes[k]!.run, from: c * LUCK_CHUNK, to: (c + 1) * LUCK_CHUNK });
            }
          }),
        );
        if (halted) return null;
        return { luck: parts.flatMap((p) => p.luck), chances: parts.flatMap((p) => p.chances) };
      } finally {
        slots.forEach((s, k) => void this.call(s, { kind: 'luck-end', run: passes[k]!.run }).catch(() => {}));
      }
    })();
  }

  /** Per worker, the luck parts it is working through, one after another (#176). */
  private luckQueue = new Map<Slot, Promise<unknown>>();

  /**
   * Chunk `c` of the luck pass of a game whose record `rec` reaches at least one state past the chunk (a
   * roll's luck reads the face from the next state): the same values as the whole game's pass gives for it
   * (#176, the review while the game is played). On the least busy worker; a worker's parts run one after
   * another (one pass at a time: its module has one leaf cache). Null where workers can't run.
   */
  luckPart(rec: GameRecord, c: number): Promise<LuckPart> | null {
    const slots = this.make();
    if (!slots) return null;
    const slot = this.pick(slots);
    const run = async () => {
      const pass = await this.call<{ run: number; states: number }>(slot, { kind: 'luck-begin', rec });
      try {
        return await this.call<LuckPart>(slot, { kind: 'luck-chunk', run: pass.run, from: c * LUCK_CHUNK, to: (c + 1) * LUCK_CHUNK });
      } finally {
        void this.call(slot, { kind: 'luck-end', run: pass.run }).catch(() => {});
      }
    };
    const p = (this.luckQueue.get(slot) ?? Promise.resolve()).then(run, run);
    this.luckQueue.set(
      slot,
      p.catch(() => {}),
    );
    return p;
  }

  /** Each worker's wasm memory in bytes (the bench's memory line); 0 for one whose engine isn't loaded. */
  async memory(): Promise<number[]> {
    const slots = this.slots ?? [];
    return Promise.all(slots.map((s) => this.call<{ bytes?: number }>(s, { kind: 'memory' }).then((m) => m.bytes ?? 0, () => 0)));
  }

  /** Ends every worker: calls in flight fail, and the memory goes with them. The next call makes a new pool. */
  stop() {
    for (const s of this.slots ?? []) {
      s.w.terminate();
      for (const p of s.pending.values()) p.fail(new Error('review worker stopped'));
      s.pending.clear();
    }
    this.slots = undefined;
    this.bySeed.clear();
    this.luckQueue.clear();
  }
}

/** The app's pool (the review queue's). */
let app: ReviewPool | undefined;
const appPool = () => (app ??= new ReviewPool());

/** The app's Reviewer: sim-wasm review in the pool of workers. Null where workers can't run. */
export function workerReviewer(): PoolReviewer | null {
  return appPool().reviewer();
}

/** The app's luck pass in the pool (ReviewPool.luck). Null where workers can't run. */
export function workerLuck(rec: GameRecord, stopped: () => boolean = () => false, yieldTo: () => boolean = () => false, have: readonly (LuckPart | undefined)[] = []): Promise<{ luck: RollLuck[]; chances: number[][] } | null> | null {
  return appPool().luck(rec, stopped, yieldTo, have);
}

/** Ends the app's pool (the review queue calls it once it's empty or paused), so no idle worker holds memory. */
export function stopReviewWorker() {
  app?.stop();
  app = undefined;
}
