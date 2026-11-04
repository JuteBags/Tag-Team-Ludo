// The review on a pool of workers (#151): the pool's size per device, and a review that is the same whatever
// the pool's size: decisions (each seeded by itself) and luck chunks (independent) give Object.is-identical
// values on 1 engine or 3, in any order; a paused-and-resumed review equals an unpaused one; and a review is
// saved sorted, finished only when complete.
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error: the project has no @types/node; Vitest runs on Node.
import { readFileSync } from 'node:fs';

// The saves runReview makes, kept here (no device storage in the tests).
const saved: { moves: { at: number }[]; done?: boolean }[] = [];
vi.mock('../src/ui/store', async (orig) => ({
  ...(await orig<typeof import('../src/ui/store')>()),
  saveReview: async (_rec: unknown, review: { moves: { at: number }[]; done?: boolean }) => void saved.push(review),
}));

import { createGame, move, replay, roll, seeded, seededDie, SEATS, type GameRecord, type GameState, type Seat } from '../src/engine';
import { chooseBotMove } from '../src/engine/ai/levels';
import { luckChunk, wasmLuck } from '../src/engine/ai/luck';
import { PLAYOUT_RULES } from '../src/engine/ai/playout-rules';
import { LUCK_CHUNK, REVIEW_VERSION, reviewMoves, type DecisionValues, type MoveReview, type Reviewer } from '../src/engine/ai/review';
import { poolSize } from '../src/engine/ai/review-worker';
import { RolloutEngine } from '../src/engine/ai/rollout';
import { moveEvent, rollEvent } from '../src/engine/record';
import { runReview } from '../src/ui/reviewRun';

const bin = new Uint8Array(readFileSync(new URL('../src/engine/ai/extreme-net.bin', import.meta.url)));
const engine = () => RolloutEngine.create(readFileSync(new URL('../src/engine/ai/ludo_wasm.wasm', import.meta.url)), bin, PLAYOUT_RULES);

/** A Hard-bot game, seat 0 the person, the app's dice. */
function game(people: 2 | 4, seed: number): GameRecord {
  const seats: Seat[] = SEATS[people].map((color, owner) => ({ color, owner, bot: owner > 0, level: 'hard' }));
  const rng = seeded(seed * 31 + 7);
  let s = createGame(seats.map((x) => ({ ...x, bot: true })), seats[seed % people]!.color);
  let events = '';
  for (let k = 0; s.phase !== 'over' && k < 20000; k++) {
    if (s.phase === 'roll') {
      const f = seededDie(seed, s);
      events += rollEvent(f);
      s = roll(s, () => 0, f);
    } else {
      const m = chooseBotMove(s, rng);
      events += moveEvent(m);
      s = move(s, m);
    }
  }
  return { v: 1, seats, first: seats[seed % people]!.color, seed, events };
}

/** Deep equality where every number is the same double (Object.is). */
const identical = (a: unknown, b: unknown): boolean =>
  typeof a === 'number' || typeof b === 'number'
    ? Object.is(a, b)
    : Array.isArray(a) && Array.isArray(b)
      ? a.length === b.length && a.every((x, i) => identical(x, b[i]))
      : a && b && typeof a === 'object' && typeof b === 'object'
        ? Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => identical((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
        : a === b;

/** A pool of engines as ReviewPool routes calls: a decision (its seed) stays on its engine, else the least busy; random delays scramble the order. */
function enginePool(engines: RolloutEngine[], jitter: () => number): Reviewer {
  const busy = engines.map(() => 0);
  const bySeed = new Map<number, number>();
  return async (s, n, seed, ask) => {
    let k = ask?.mode === 'screen' ? undefined : bySeed.get(seed);
    if (k === undefined) {
      k = busy.indexOf(Math.min(...busy));
      if (ask?.mode !== 'screen') bySeed.set(seed, k);
    }
    busy[k]!++;
    await new Promise((r) => setTimeout(r, jitter()));
    try {
      return engines[k]!.reviewFast(s, n, seed, ask);
    } finally {
      busy[k]!--;
    }
  };
}

describe('the review on a pool of workers (#151)', () => {
  it('sizes the pool by the device: a core for the UI, at most 3 on a phone, 6 on a computer, at most 2 with 2 GB or less', () => {
    const phone = { userAgentData: { mobile: true } };
    expect(poolSize({ ...phone, hardwareConcurrency: 8, deviceMemory: 8 })).toBe(3);
    expect(poolSize({ ...phone, hardwareConcurrency: 4 })).toBe(3);
    expect(poolSize({ ...phone, hardwareConcurrency: 3 })).toBe(2);
    expect(poolSize({ ...phone, hardwareConcurrency: 2 })).toBe(1);
    expect(poolSize({ ...phone, hardwareConcurrency: 1 })).toBe(1);
    expect(poolSize({ ...phone, hardwareConcurrency: 8, deviceMemory: 2 })).toBe(2);
    expect(poolSize({ ...phone, hardwareConcurrency: 8, deviceMemory: 1 })).toBe(2);
    expect(poolSize(phone)).toBe(3);
    // No userAgentData (Safari, Firefox): a finger as the main pointer is a phone or tablet.
    expect(poolSize({ hardwareConcurrency: 8 }, true)).toBe(3);
    // A computer.
    const pc = { userAgentData: { mobile: false } };
    expect(poolSize({ ...pc, hardwareConcurrency: 16, deviceMemory: 8 })).toBe(6);
    expect(poolSize({ ...pc, hardwareConcurrency: 8 })).toBe(6);
    expect(poolSize({ ...pc, hardwareConcurrency: 6 })).toBe(5);
    expect(poolSize({ ...pc, hardwareConcurrency: 4 })).toBe(3);
    expect(poolSize({ ...pc, hardwareConcurrency: 16, deviceMemory: 2 })).toBe(2);
    expect(poolSize({ hardwareConcurrency: 12 }, false)).toBe(6);
    // A mouse with userAgentData saying mobile (a tablet with a trackpad): the browser wins.
    expect(poolSize({ ...phone, hardwareConcurrency: 8 }, false)).toBe(3);
  });

  it('reviews a game the same on 1 engine as on 3 at once, or 3 at once on one engine, whatever the order', async () => {
    const rec = game(2, 5);
    const states = (replay(rec).states as GameState[]).slice(0, 160);
    const [a, b, c, d] = await Promise.all([engine(), engine(), engine(), engine()]);
    let r = 1;
    const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648) * 6;
    const one = await reviewMoves(rec, states, [0], enginePool([a!], () => 0), undefined, undefined, undefined, { order: 'stakes' });
    const three = await reviewMoves(rec, states, [0], enginePool([b!, c!, d!], rnd), undefined, undefined, undefined, { order: 'stakes', parallel: 3 });
    // Three decisions interleaved on one engine: its kept playouts are another decision's, so it plays them anew.
    const shared = await reviewMoves(rec, states, [0], enginePool([a!], rnd), undefined, undefined, undefined, { order: 'stakes', parallel: 3 });
    expect(one.length).toBeGreaterThan(10);
    expect(identical(three, one)).toBe(true);
    expect(identical(shared, one)).toBe(true);
  }, 300_000);

  it("reviews a game the same on a computer's 6 engines at once as on 1", async () => {
    const rec = game(4, 11);
    const states = (replay(rec).states as GameState[]).slice(0, 160);
    const es = await Promise.all(Array.from({ length: 7 }, () => engine()));
    let r = 3;
    const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648) * 6;
    const one = await reviewMoves(rec, states, [0], enginePool([es[0]!], () => 0), undefined, undefined, undefined, { order: 'stakes' });
    const six = await reviewMoves(rec, states, [0], enginePool(es.slice(1), rnd), undefined, undefined, undefined, { order: 'stakes', parallel: 6 });
    expect(one.length).toBeGreaterThan(10);
    expect(identical(six, one)).toBe(true);
  }, 300_000);

  it('works out the luck the same in chunks over 3 or 6 engines as on 1', async () => {
    const rec = game(4, 102);
    const states = (replay(rec).states as GameState[]).slice(0, 5 * LUCK_CHUNK);
    const [a, b, c, d] = await Promise.all([engine(), engine(), engine(), engine()]);
    const run = (es: RolloutEngine[]) => {
      const srcs = es.map((e) => wasmLuck(e));
      srcs.forEach((s) => s.begin());
      // Chunks dealt out of order: the last first, round-robin over the engines.
      const n = Math.ceil(states.length / LUCK_CHUNK);
      const parts: ReturnType<typeof luckChunk>[] = new Array(n);
      for (let k = n - 1; k >= 0; k--) parts[k] = luckChunk(srcs[k % srcs.length]!, rec, states, k * LUCK_CHUNK, Math.min(states.length, (k + 1) * LUCK_CHUNK));
      srcs.forEach((s) => s.end());
      return { luck: parts.flatMap((p) => p.luck), chances: parts.flatMap((p) => p.chances) };
    };
    const one = run([a!]);
    const three = run([b!, c!, d!]);
    const six = run([b!, c!, d!, ...(await Promise.all([engine(), engine(), engine()]))]);
    expect(one.luck.length).toBeGreaterThan(50);
    expect(identical(three, one)).toBe(true);
    expect(identical(six, one)).toBe(true);
  }, 300_000);

  describe('a run through runReview: paused and resumed, and its saves', () => {
    // A deterministic stand-in for the engine: values from the decision's seed, with random delays.
    const fake = (jitter: () => number): Reviewer & { parallel: number } =>
      Object.assign(
        async (s: GameState, n: number, seed: number): Promise<DecisionValues> => {
          await new Promise((r) => setTimeout(r, jitter()));
          const k = new Set(s.moves.map((m) => JSON.stringify(move(s, m).players.map((p) => p.tokens)))).size;
          const g = (c: number) => (c ? ((seed >>> (c * 3)) % 9) / 100 + 0.005 : 0);
          return { ofMove: s.moves.map((_, i) => i % k), mean: Array.from({ length: k }, (_, c) => 0.6 - g(c)), gap: Array.from({ length: k }, (_, c) => g(c)), se: Array.from({ length: k }, () => 0.04 / Math.sqrt(n / 128)), best: 0 };
        },
        { parallel: 3 },
      );
    const noLuck = async () => ({ luck: [], chances: [] });
    let r = 7;
    const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648) * 5;
    const rec = game(2, 9);
    const finish = (stored?: Parameters<typeof runReview>[1], stopAfter = Infinity) =>
      new Promise<MoveReview[]>((done) => {
        let stop = () => {};
        let seen = 0;
        stop = runReview(
          rec,
          stored,
          (p) => {
            if (p.finished) return done(p.moves);
            if (++seen === stopAfter) {
              stop();
              done(p.moves);
            }
          },
          true,
          fake(rnd),
          [0],
          noLuck,
        );
      });

    it('loses no verdict when paused and resumed, and ends exactly as an unpaused run', async () => {
      const full = await finish();
      // Paused after 6 verdicts (with 3 in flight), then resumed from what it had.
      const part = await finish(undefined, 6);
      expect(part.length).toBeGreaterThan(0);
      expect(part.length).toBeLessThan(full.length);
      const resumed = await finish({ v: REVIEW_VERSION, moves: part, luck: [] });
      expect(identical(resumed, full)).toBe(true);
    }, 120_000);

    it('saves a review sorted by position, and finished only when complete', async () => {
      saved.length = 0;
      const full = await finish();
      expect(saved.length).toBeGreaterThan(1);
      for (const s of saved) expect(s.moves.map((m) => m.at)).toEqual([...s.moves].map((m) => m.at).sort((x, y) => x - y));
      // Only the last save says done, and it holds every verdict.
      expect(saved.filter((s) => s.done).length).toBe(1);
      expect(saved.at(-1)!.done).toBe(true);
      expect(saved.at(-1)!.moves.length).toBe(full.length);
    }, 120_000);
  });
});
