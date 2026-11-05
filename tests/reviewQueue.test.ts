// The review queue (src/ui/reviewQueue.ts, #96): which game it reviews first, when it pauses, the newest-few
// cap, and that it ends the worker once empty. Plus the luck percentile (review.ts luckPercent).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseMove, createGame, move, moveEvent, roll, rollEvent, seeded, seededDie, type GameRecord, type GameState, type Seat } from '../src/engine';
import { accuracyOf, luckPercent, normalCdf, type DecisionValues, type ReviewAsk, type MoveReview } from '../src/engine/ai/review';

const mem = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: mem.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => void mem.set(key, value),
    remove: async ({ key }: { key: string }) => void mem.delete(key),
  },
}));
// A fake worker: each decision waits for a tick we control, so a test can see what's running.
let calls: string[] = [];
let luckArgs: unknown[][] = [];
let release: (() => void)[] = [];
const stopped = vi.fn();
vi.mock('../src/engine/ai/review-worker', () => ({
  workerReviewer: () => async (s: GameState, _n: number, _seed: number, ask?: ReviewAsk): Promise<DecisionValues> => {
    // The stakes order's net screen (#101): this fake has none, so it answers at once and the order stays the game's.
    if (ask?.mode === 'screen') return { ofMove: s.moves.map((_, i) => i), mean: [], gap: [], se: [], best: 0 };
    calls.push(s.players.map((p) => p.tokens.join(',')).join('|'));
    await new Promise<void>((r) => release.push(r));
    return { ofMove: s.moves.map((_, i) => i), mean: s.moves.map((_, i) => (i ? 0.595 : 0.7)), gap: s.moves.map((_, i) => (i ? 0.105 : 0)), se: s.moves.map(() => 0.01), best: 0 };
  },
  workerLuck: (...args: unknown[]) => (luckArgs.push(args), Promise.resolve({ luck: [], chances: [] })),
  stopReviewWorker: () => stopped(),
}));
const Q = await import('../src/ui/reviewQueue');

const SEATS: Seat[] = [{ color: 'blue', owner: 0, bot: false }, { color: 'red', owner: 1, bot: true, level: 'hard' }];
function game(seed: number): GameRecord {
  const rng = seeded(seed);
  let s = createGame(SEATS, 'blue');
  let events = '';
  while (s.phase !== 'over') {
    if (s.phase === 'roll') {
      const f = seededDie(seed, s);
      events += rollEvent(f);
      s = roll(s, () => 0, f);
    } else {
      const m = chooseMove(s, rng, 'easy');
      events += moveEvent(m);
      s = move(s, m);
    }
  }
  return { v: 1, seats: SEATS, first: 'blue', seed, events };
}
const flush = () => new Promise((r) => setTimeout(r, 5));
/** Waits (up to 10 s, for a loaded machine) until `ok()` holds, instead of guessing how long the queue's awaits take. */
const until = async (ok: () => boolean) => {
  for (let t = 0; t < 2000 && !ok(); t++) await flush();
};
/** Lets the decision in progress finish (once there is one), and the queue move on to the next. */
const step = async () => {
  await until(() => release.length > 0);
  const n = calls.length;
  release.shift()?.();
  await until(() => calls.length > n || release.length > 0);
};

beforeEach(() => {
  Q.resetQueue();
  calls = [];
  luckArgs = [];
  release = [];
  mem.clear();
  stopped.mockClear();
});

// Each test drives a whole review through the fake worker: generous time for a loaded full suite.
describe('review queue', { timeout: 60_000 }, () => {
  it('reviews the game being looked at first, and keeps going after it is left', async () => {
    const a = game(1);
    const b = game(2);
    Q.enqueue(a, { keep: false, at: 2 });
    await step();
    expect(Q.progressOf(a)?.done).toBeGreaterThan(0);
    // Opening b puts it first: a gives way.
    const seen: number[] = [];
    const off = Q.follow(b, (p) => seen.push(p.done), { keep: false, open: true });
    await step();
    await step();
    expect(Q.progressOf(b)?.done).toBeGreaterThan(0);
    const aDone = Q.progressOf(a)!.done;
    off();
    // Left the screen: b still moves on.
    const before = Q.progressOf(b)!.done;
    await step();
    expect(Q.progressOf(b)!.done).toBeGreaterThan(before);
    expect(Q.progressOf(a)!.done).toBe(aDone);
  });

  it("reports your side's progress apart from a bot's side asked for on demand", async () => {
    const a = game(13);
    Q.enqueue(a, { keep: false });
    for (let i = 0; i < 400 && !Q.progressOf(a)?.finished; i++) await step();
    expect(Q.progressOf(a)?.mine.finished).toBe(true);
    // The bot's side, asked for later: the job runs again, but your side stays finished.
    Q.follow(a, () => {}, { keep: false, open: true, who: [1] });
    await step();
    expect(Q.progressOf(a)?.finished).toBe(false);
    expect(Q.progressOf(a)?.mine.finished).toBe(true);
  });

  it('pauses during any game (the game is reviewed as it is played, #176), and goes on after it', async () => {
    const a = game(3);
    for (const kind of ['extreme', 'light'] as const) {
      Q.setGame(kind);
      Q.enqueue(a, { keep: false });
      await flush();
      await flush();
      expect(calls.length).toBe(0);
    }
    Q.setGame('none');
    await step();
    expect(calls.length).toBeGreaterThan(0);
  });

  it("starts from what the game's live review did: only the rest is reviewed, its luck chunks go to the luck pass (#176)", async () => {
    const a = game(12);
    // Lets every decision through until the review finishes (never waiting out a call that won't come).
    const drain = async () => {
      while (!Q.progressOf(a)?.finished) {
        await until(() => release.length > 0 || !!Q.progressOf(a)?.finished);
        release.shift()?.();
      }
    };
    // The whole review once, for its verdicts.
    Q.follow(a, () => {}, { keep: false, open: true });
    await drain();
    const all = Q.progressOf(a)!.moves;
    expect(all.length).toBeGreaterThan(2);
    Q.resetQueue();
    calls = [];
    luckArgs = [];
    // The game hands off all but its last two verdicts, and one luck chunk.
    const part = { luck: [], chances: [[50, 50]] };
    Q.enqueue(a, { keep: false, live: { moves: all.slice(0, -2), skip: [], luckHave: [part] } });
    await drain();
    expect(Q.progressOf(a)?.finished).toBe(true);
    expect(calls.length).toBe(2);
    expect(Q.progressOf(a)!.moves.map((m) => m.at)).toEqual(all.map((m) => m.at));
    expect(luckArgs.at(-1)![3]).toEqual([part]);
  });

  it('queues only the newest few games on its own', async () => {
    Q.setGame('extreme');
    const gs = [game(4), game(5), game(6), game(7), game(8)];
    gs.forEach((g, i) => Q.enqueue(g, { keep: false, at: i }));
    const queued = gs.filter((g) => Q.isQueued(g));
    expect(queued.length).toBe(Q.AUTO_QUEUE);
    expect(queued).toEqual(gs.slice(-Q.AUTO_QUEUE));
  });

  it('finishes a review even when a screen following it throws', async () => {
    const a = game(10);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    Q.follow(a, () => {
      throw new Error('broken screen');
    }, { keep: false, open: true });
    for (let i = 0; i < 400 && !Q.progressOf(a)?.finished; i++) await step();
    expect(Q.progressOf(a)?.finished).toBe(true);
    err.mockRestore();
  });

  it('ends the worker once there is nothing left to review', async () => {
    const a = game(9);
    Q.enqueue(a, { keep: false });
    for (let i = 0; i < 400 && !Q.progressOf(a)?.finished; i++) await step();
    expect(Q.progressOf(a)?.finished).toBe(true);
    await flush();
    expect(stopped).toHaveBeenCalled();
  });
});

describe('luck percentile', () => {
  it('is 50 for average dice and moves with luck against its spread', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    const r = (luck: number, sd = 10) => ({ at: 0, owner: 0, face: 3, luck, sd });
    expect(luckPercent([r(5), r(-5)], 0)).toBeCloseTo(50, 5);
    expect(luckPercent([r(10), r(10)], 0)).toBeGreaterThan(90);
    expect(luckPercent([r(-10), r(-10)], 0)).toBeLessThan(10);
    expect(luckPercent([{ at: 0, owner: 0, face: 3, luck: 4 }], 0)).toBeNaN();
  });
});

describe('accuracy', () => {
  const m = (gap: number, gaps: number[]): MoveReview => ({ at: 0, owner: 0, played: 1, best: 0, playedChance: 0.5, bestChance: 0.5, gap, se: 0.1, label: 'inaccuracy', gaps });
  const lab = (x: MoveReview, label: MoveReview['label']): MoveReview => ({ ...x, label });
  it('is the share of what was at stake that was kept, over meaningful decisions only', () => {
    // A 30-point decision with a 6-point slip, a 10-point one played perfectly, and a 1-point Good one left out.
    expect(accuracyOf([m(6, [0, 30]), lab(m(0, [0, 10]), 'best'), lab(m(1, [0, 1]), 'good')])).toBeCloseTo(1 - 6 / 40, 6);
    expect(accuracyOf([lab(m(1, [0, 1]), 'good')])).toBeNaN();
    // A Best move's gap is noise: it costs nothing.
    expect(accuracyOf([{ ...m(1.2, [0, 1.2, 20]), label: 'best' }, m(4, [0, 4, 10])])).toBeCloseTo(1 - 4 / 30, 6);
  });

  describe('never a false 100% (#133)', () => {
    const best = (spread: number) => lab(m(0, [0, spread]), 'best');
    it('counts a labelled move whose decision had little at stake (a 4p Inaccuracy, spread under 3)', () => {
      // Everything else Best; the only slip is an Inaccuracy of 1.8 in a 2.4-point decision (3p/4p cuts start near 1.7).
      const acc = accuracyOf([best(20), best(15), m(1.8, [0, 2.4])]);
      expect(acc).toBeLessThan(1);
      expect(acc).toBeCloseTo(1 - 1.8 / 37.4, 6);
      expect(Math.round(100 * acc)).toBeLessThan(100);
    });
    it("caps a near-perfect game at 99%: 2.5 points given up out of 500 doesn't round to 100", () => {
      const moves = [...Array.from({ length: 49 }, () => best(10)), lab(m(2.5, [0, 10]), 'good')];
      expect(1 - 2.5 / 500).toBeGreaterThan(0.99);
      expect(accuracyOf(moves)).toBe(0.99);
      expect(Math.round(100 * accuracyOf(moves))).toBe(99);
    });
    it('is 100% only when every counted move is Best', () => {
      expect(accuracyOf([best(20), best(8)])).toBe(1);
      // A Best move's noise in a small decision still doesn't count against it.
      expect(accuracyOf([best(20), lab(m(0.4, [0, 0.4, 1]), 'best')])).toBe(1);
    });
    it('is still "–" (NaN) with no counted decision', () => {
      expect(accuracyOf([best(1), lab(m(0.5, [0, 2]), 'good')])).toBeNaN();
      expect(accuracyOf([])).toBeNaN();
    });
    it('caps the old label-score fallback too (reviews without every gap)', () => {
      const old = [...Array.from({ length: 39 }, () => ({ ...best(10), gaps: undefined })), { ...lab(m(1, [0, 10]), 'good'), gaps: undefined }];
      expect(accuracyOf(old)).toBe(0.99);
    });
  });
});
