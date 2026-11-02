// The review queue (src/ui/reviewQueue.ts, #96): which game it reviews first, when it pauses, the newest-few
// cap, and that it ends the worker once empty. Plus the luck percentile (review.ts luckPercent).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseMove, createGame, move, moveEvent, roll, rollEvent, seeded, seededDie, type GameRecord, type GameState, type Seat } from '../src/engine';
import { luckPercent, normalCdf, type DecisionValues } from '../src/engine/ai/review';

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
let release: (() => void)[] = [];
const stopped = vi.fn();
vi.mock('../src/engine/ai/review-worker', () => ({
  workerReviewer: () => async (s: GameState): Promise<DecisionValues> => {
    calls.push(s.players.map((p) => p.tokens.join(',')).join('|'));
    await new Promise<void>((r) => release.push(r));
    return { ofMove: s.moves.map((_, i) => i), mean: s.moves.map((_, i) => (i ? 0.4 : 0.5)), gap: s.moves.map((_, i) => (i ? 0.1 : 0)), se: s.moves.map(() => 0.01), best: 0 };
  },
  workerLuck: () => Promise.resolve({ luck: [], chances: [] }),
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
/** Lets the decision in progress finish. */
const step = async () => {
  await flush();
  release.shift()?.();
  await flush();
};

beforeEach(() => {
  Q.resetQueue();
  calls = [];
  release = [];
  mem.clear();
  stopped.mockClear();
});

describe('review queue', () => {
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

  it('pauses during an Extreme game, not during others', async () => {
    const a = game(3);
    Q.setGame('extreme');
    Q.enqueue(a, { keep: false });
    await step();
    expect(calls.length).toBe(0);
    Q.setGame('light');
    await step();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('queues only the newest few games on its own', async () => {
    Q.setGame('extreme');
    const gs = [game(4), game(5), game(6), game(7), game(8)];
    gs.forEach((g, i) => Q.enqueue(g, { keep: false, at: i }));
    const queued = gs.filter((g) => Q.isQueued(g));
    expect(queued.length).toBe(Q.AUTO_QUEUE);
    expect(queued).toEqual(gs.slice(-Q.AUTO_QUEUE));
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
