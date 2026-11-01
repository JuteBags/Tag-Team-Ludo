// The game review's words and graph (src/ui/reviewText.ts) and its runner (src/ui/reviewRun.ts).
import { describe, expect, it, vi } from 'vitest';
import { chooseMove, createGame, move, moveEvent, replay, roll, rollEvent, seeded, seededDie, type GameRecord, type GameState, type Seat } from '../src/engine';
import { REVIEW_VERSION, type DecisionValues, type MoveReview } from '../src/engine/ai/review';
import { evenChance, graphPoints, luckWords, moveText } from '../src/ui/reviewText';

const mem = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: mem.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => void mem.set(key, value),
    remove: async ({ key }: { key: string }) => void mem.delete(key),
  },
}));
vi.mock('../src/engine/ai/review-worker', () => ({ workerReviewer: () => null, workerLuck: () => Promise.resolve([]) }));
const { runReview, decisionsToReview } = await import('../src/ui/reviewRun');

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

describe('review words', () => {
  it('says luck in words first, and calls small luck average', () => {
    expect(luckWords(12.4, true)).toMatchObject({ word: 'Lucky dice', tone: 'lucky', line: 'Your dice gave you 12% more winning chances than average dice.' });
    expect(luckWords(-8, true).word).toBe('Unlucky dice');
    expect(luckWords(4.9, true).tone).toBe('average');
    expect(luckWords(-30, false).line).toMatch(/^Their dice cost them 30%/);
  });

  it('puts the even line at 100 / people, and the graph on a 0-100 axis', () => {
    expect(evenChance(2)).toBe(50);
    expect(evenChance(4)).toBe(25);
    expect(graphPoints([0, 0.5, 1], 100, 50)).toEqual([[0, 50], [50, 25], [100, 0]]);
    expect(graphPoints([2], 100, 50)).toEqual([[50, 0]]);
  });

  it('describes moves in a few words', () => {
    const base = { kind: 'normal', color: 'blue', tokens: [0], from: 3, to: 8, steps: 5, roll: 5, captures: [], finishes: 0 } as never;
    expect(moveText(base)).toBe('moved 5');
    expect(moveText({ ...(base as object), kind: 'release' } as never)).toBe('brought a token out');
    expect(moveText({ ...(base as object), tokens: [0, 1], steps: 3 } as never)).toBe('moved a pair 3');
  });
});

describe('review runner', () => {
  it('picks up a stored review and skips the moves already done; another version starts over', async () => {
    const rec = game(9);
    let calls = 0;
    // Every other move 10 points down: away from every label's edge, so one call per decision.
    const fake = async (s: GameState): Promise<DecisionValues> => {
      calls++;
      return { ofMove: s.moves.map((_, i) => i), mean: s.moves.map((_, i) => (i ? 0.4 : 0.5)), gap: s.moves.map((_, i) => (i ? 0.1 : 0)), se: s.moves.map(() => 0.01), best: 0 };
    };
    const run = (stored?: Parameters<typeof runReview>[1]) =>
      new Promise<MoveReview[]>((done) => runReview(rec, stored, (p) => p.finished && done(p.moves), false, fake));
    const all = await run();
    const full = calls;
    expect(all.length).toBeGreaterThan(5);
    expect(full).toBe(all.length);
    // Half of it stored: only the other half is reviewed, and the result is the same.
    calls = 0;
    const half = all.slice(0, Math.floor(all.length / 2));
    const resumed = await run({ v: REVIEW_VERSION, moves: half, luck: [] });
    expect(calls).toBe(all.length - half.length);
    expect(resumed).toEqual(all);
    // A review stored by another version is redone in full.
    calls = 0;
    await run({ v: REVIEW_VERSION + 1, moves: half, luck: [] });
    expect(calls).toBe(full);
    expect(decisionsToReview(rec, replay(rec).states)).toBeGreaterThanOrEqual(all.length);
  });
});
