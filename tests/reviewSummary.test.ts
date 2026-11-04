// Review summaries (src/ui/store.ts, #98): the app start and the Stats list read one small index instead of
// every full review; the full review is still the truth (opening a game reads it and fixes its summary), and a
// review stored before summaries existed is read in full once, then summarised.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REVIEW_VERSION, type MoveReview } from '../src/engine/ai/review';
import type { GameRecord, Seat } from '../src/engine';

const mem = new Map<string, string>();
const reads: string[] = [];
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => (reads.push(key), { value: mem.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => void mem.set(key, value),
    remove: async ({ key }: { key: string }) => void mem.delete(key),
  },
}));
vi.mock('../src/engine/ai/review-worker', () => ({ workerReviewer: () => null, workerLuck: () => null, stopReviewWorker: () => {} }));
vi.stubGlobal('document', { addEventListener: () => {}, hidden: false });

const SEATS: Seat[] = [
  { color: 'blue', owner: 0, bot: false },
  { color: 'red', owner: 1, bot: true, level: 'hard' },
];
const rec = (i: number): GameRecord => ({ v: 1, seats: SEATS, first: 'blue', seed: 1000 + i, events: `${i}` });
const move = (at: number, gap: number, label: MoveReview['label']): MoveReview => ({ at, owner: 0, played: 1, best: 0, playedChance: 0.4, bestChance: 0.45, gap, se: 0.3, label, gaps: [0, gap, 9] });
const review = (done = true) => ({ v: REVIEW_VERSION, moves: [move(2, 0, 'best'), move(5, 12, 'mistake')], luck: [], done });

/** A fresh copy of the store and the queue, as at an app start (their module state starts over). */
async function boot() {
  vi.resetModules();
  const store = await import('../src/ui/store');
  const queue = await import('../src/ui/reviewQueue');
  return { store, queue };
}
const fullReads = () => reads.filter((k) => k.startsWith('ludo-review-') && k !== 'ludo-review-index').length;

beforeEach(() => {
  mem.clear();
  reads.length = 0;
});

describe('review summaries', () => {
  it('a cold start with 20 finished reviews reads the index, not one full review', async () => {
    const { store } = await boot();
    for (let i = 0; i < 20; i++) await store.savePastGame({ rec: rec(i), at: i, mode: 'pvc', place: 1 });
    for (let i = 0; i < 20; i++) await store.saveReview(rec(i), review());
    const { queue } = await boot();
    reads.length = 0;
    await queue.bootReviews();
    expect(fullReads()).toBe(0);
    expect(reads.filter((k) => k === 'ludo-review-index').length).toBe(1);
    expect(queue.progressOf(rec(0))).toBeUndefined(); // nothing queued: all finished
  });

  it('a review stored before summaries is read in full once, then summarised for the next start', async () => {
    const { store } = await boot();
    await store.savePastGame({ rec: rec(1), at: 1, mode: 'pvc', place: 1 });
    // As an older build stored it: the review alone, no index.
    mem.set(store.reviewKey(rec(1)), JSON.stringify(review()));
    const first = await boot();
    reads.length = 0;
    await first.queue.bootReviews();
    expect(fullReads()).toBe(1);
    await vi.waitFor(async () => expect(await first.store.loadSummary(rec(1))).toBeDefined());
    const second = await boot();
    reads.length = 0;
    await second.queue.bootReviews();
    expect(fullReads()).toBe(0);
  });

  it("is only a hint: opening a game reads the full review and corrects a summary that's wrong", async () => {
    const { store } = await boot();
    await store.savePastGame({ rec: rec(2), at: 2, mode: 'pvc', place: 1 });
    await store.saveReview(rec(2), review());
    const right = await store.loadSummary(rec(2));
    expect(right).toEqual(store.summaryOf(rec(2), review()));
    expect(right!.owners[0]).toMatchObject({ moves: 2, mistake: 1, blunder: 0 });
    // Someone's index says otherwise (an older build, a crash between writes).
    const index = JSON.parse(mem.get('ludo-review-index')!);
    index[store.reviewKey(rec(2))] = { ...right, owners: [{ moves: 9, accuracy: 0.1, luckPct: null, mistake: 7, blunder: 7 }] };
    mem.set('ludo-review-index', JSON.stringify(index));
    expect(await store.loadReview(rec(2))).toEqual(review());
    await vi.waitFor(async () => expect(await store.loadSummary(rec(2))).toEqual(right));
  });

  it('redoes a summary made under older accuracy rules from the full review, with no label version bump (#133)', async () => {
    const { store } = await boot();
    await store.savePastGame({ rec: rec(3), at: 3, mode: 'pvc', place: 1 });
    await store.saveReview(rec(3), review());
    const right = await store.loadSummary(rec(3));
    expect(right?.acc).toBeDefined();
    // A summary written before #133 has no accuracy tag (and could say 100%): it isn't trusted.
    const index = JSON.parse(mem.get('ludo-review-index')!);
    const { acc: _acc, ...old } = right!;
    index[store.reviewKey(rec(3))] = { ...old, owners: [{ ...old.owners[0], accuracy: 1 }, old.owners[1]] };
    mem.set('ludo-review-index', JSON.stringify(index));
    expect(await store.loadSummary(rec(3))).toBeUndefined();
    // The full review (same REVIEW_VERSION, every gap kept) gives the right numbers and rewrites the summary.
    expect((await store.loadReview(rec(3)))?.v).toBe(REVIEW_VERSION);
    await vi.waitFor(async () => expect(await store.loadSummary(rec(3))).toEqual(right));
  });

  it('drops a summary with its game when the game falls out of the kept 20', async () => {
    const { store } = await boot();
    for (let i = 0; i < 21; i++) {
      await store.savePastGame({ rec: rec(100 + i), at: i, mode: 'pvc', place: 1 });
      if (i === 0) await store.saveReview(rec(100), review());
    }
    expect(Object.keys(await store.loadSummaries())).not.toContain(store.reviewKey(rec(100)));
  });
});
