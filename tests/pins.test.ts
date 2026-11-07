// Pinned games (#97, src/ui/store.ts): up to MAX_PINS games never roll off the KEEP_GAMES list, nor do their
// reviews; an 11th pin is refused; an unpinned old game goes at the next save. And the storage it costs.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameRecord } from '../src/engine';

const mem = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: mem.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => void mem.set(key, value),
    remove: async ({ key }: { key: string }) => void mem.delete(key),
  },
}));
const S = await import('../src/ui/store');

/** A distinct game's record (only its identity matters here). */
const rec = (i: number): GameRecord => ({ v: 1, seats: [{ color: 'blue', owner: 0, bot: false }, { color: 'red', owner: 1, bot: true, level: 'hard' }], first: 'blue', seed: i, events: `6a6${i % 6 + 1}` });
const save = (i: number) => S.savePastGame({ rec: rec(i), at: i, mode: 'pvc', place: 1 });
const seeds = async () => (await S.loadPastGames()).map((g) => g.rec.seed);

beforeEach(() => mem.clear());

describe('pinned games (#97)', () => {
  it('keep the newest KEEP_GAMES unpinned games and every pinned one', async () => {
    for (let i = 0; i < 5; i++) await save(i);
    expect(await S.pinGame(rec(0), true)).toBe(true);
    expect(await S.pinGame(rec(1), true)).toBe(true);
    for (let i = 5; i < 5 + S.KEEP_GAMES + 3; i++) await save(i);
    const kept = await seeds();
    expect(kept).toContain(0);
    expect(kept).toContain(1);
    expect(kept.length).toBe(S.KEEP_GAMES + 2);
    // The unpinned old ones (2, 3, 4) rolled off.
    expect(kept).not.toContain(2);
  });

  it("keep their reviews: a pinned game's review survives the roll-off", async () => {
    await save(0);
    await S.saveReview(rec(0), { v: 4, moves: [], luck: [], done: true });
    await S.pinGame(rec(0), true);
    for (let i = 1; i <= S.KEEP_GAMES + 2; i++) await save(i);
    expect(await S.loadReview(rec(0))).toBeDefined();
  });

  it('refuse an 11th pin, and take one again after an unpin', async () => {
    for (let i = 0; i <= S.MAX_PINS; i++) await save(i);
    for (let i = 0; i < S.MAX_PINS; i++) expect(await S.pinGame(rec(i), true)).toBe(true);
    expect(await S.pinGame(rec(S.MAX_PINS), true)).toBe(false);
    expect(await S.pinGame(rec(0), false)).toBe(true);
    expect(await S.pinGame(rec(S.MAX_PINS), true)).toBe(true);
    // Pinning a game that isn't kept says false.
    expect(await S.pinGame(rec(999), true)).toBe(false);
  });

  it('an unpinned old game stays until the next game is saved, then rolls off', async () => {
    await save(0);
    await S.pinGame(rec(0), true);
    for (let i = 1; i <= S.KEEP_GAMES; i++) await save(i);
    await S.pinGame(rec(0), false);
    expect(await seeds()).toContain(0);
    await save(100);
    expect(await seeds()).not.toContain(0);
  });
});
