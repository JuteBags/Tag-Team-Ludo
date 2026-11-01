// The game review's words and graph (src/ui/reviewText.ts) and its runner (src/ui/reviewRun.ts).
import { describe, expect, it, vi } from 'vitest';
import { chooseMove, createGame, move, moveEvent, replay, roll, rollEvent, seeded, seededDie, type GameRecord, type GameState, type Seat } from '../src/engine';
import { REVIEW_VERSION, type DecisionValues, type MoveReview } from '../src/engine/ai/review';
import { bigRolls, etaText, evenChance, graphPoints, keyMoves, luckWords, moveText, reviewedText, rollText } from '../src/ui/reviewText';

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
    expect(luckWords(12.4, true)).toMatchObject({ word: 'Lucky dice', tone: 'lucky', line: 'your rolls gave you 12 points of winning chance more than average rolls.' });
    expect(luckWords(-17, true).line).toBe('your rolls cost you 17 points of winning chance compared with average rolls.');
    expect(luckWords(-8, true).word).toBe('Unlucky dice');
    expect(luckWords(4.9, true).tone).toBe('average');
    expect(luckWords(-30, false).line).toMatch(/^their rolls cost them 30 points/);
    expect(luckWords(-30, false).line).not.toMatch(/%/);
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

describe('key moves and big rolls', () => {
  const mv = (at: number, label: MoveReview['label'], gap: number): MoveReview => ({ at, owner: 0, played: 0, best: 1, playedChance: 0.5, bestChance: 0.5, gap, se: 0.5, label });
  it('lists only the moves that lost something, most points lost first', () => {
    const k = keyMoves([mv(1, 'best', 0), mv(2, 'inaccuracy', 4), mv(3, 'blunder', 22), mv(4, 'good', 2), mv(5, 'mistake', 9), mv(6, 'inaccuracy', 4)]);
    expect(k.map((m) => m.at)).toEqual([3, 5, 2, 6]);
  });
  it('picks the rolls that swung the game most, for anyone, lucky or not', () => {
    const r = bigRolls([{ at: 1, owner: 0, face: 6, luck: 3 }, { at: 2, owner: 1, face: 6, luck: 15 }, { at: 3, owner: 0, face: 1, luck: -12 }, { at: 4, owner: 1, face: 2, luck: -1 }, { at: 5, owner: 0, face: 5, luck: 8 }]);
    expect(r.map((x) => x.at)).toEqual([2, 3, 5]);
    expect(rollText(r[0]!, 'Aarav', false)).toBe("Aarav's lucky 6: +15 for them");
    expect(rollText(r[1]!, 'You', true)).toBe('Your unlucky 1: −12');
  });
});

describe('progress words', () => {
  it('rounds the time left to half minutes and says almost done near the end', () => {
    expect(etaText(null)).toBe('');
    expect(etaText(12)).toBe('Almost done');
    expect(etaText(25)).toBe('About half a minute left');
    expect(etaText(60)).toBe('About 1 minute left');
    expect(etaText(100)).toBe('About 1½ minutes left');
    expect(etaText(130)).toBe('About 2 minutes left');
  });
  it('dates a review in words', () => {
    const now = new Date(2026, 10, 2, 15, 0).getTime();
    expect(reviewedText(undefined, now)).toBe('');
    expect(reviewedText(new Date(2026, 10, 2, 0, 5).getTime(), now)).toBe('Reviewed today');
    expect(reviewedText(new Date(2026, 10, 1, 23, 0).getTime(), now)).toBe('Reviewed yesterday');
    expect(reviewedText(new Date(2026, 9, 20).getTime(), now)).toBe('Reviewed 20 Oct');
    expect(reviewedText(new Date(2025, 9, 20).getTime(), now)).toBe('Reviewed 20 Oct 2025');
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
    // Reopening a finished review redoes nothing and keeps its date.
    calls = 0;
    const when = await new Promise<number | undefined>((done) => runReview(rec, { v: REVIEW_VERSION, moves: all, luck: [], when: 123 }, (p) => p.finished && done(p.when), false, fake));
    expect(calls).toBe(0);
    expect(when).toBe(123);
  });

  it('estimates the time left once a few verdicts are in, and dates the finished review', async () => {
    const rec = game(9);
    const fake = async (s: GameState): Promise<DecisionValues> => ({ ofMove: s.moves.map((_, i) => i), mean: s.moves.map((_, i) => (i ? 0.4 : 0.5)), gap: s.moves.map((_, i) => (i ? 0.1 : 0)), se: s.moves.map(() => 0.01), best: 0 });
    const seen: (number | null)[] = [];
    const end = await new Promise<{ when?: number; eta: number | null }>((done) =>
      runReview(rec, undefined, (p) => (p.finished ? done(p) : seen.push(p.eta)), false, fake),
    );
    expect(seen.slice(0, 3).every((e) => e === null)).toBe(true);
    expect(seen.at(-1)).not.toBeNull();
    expect(end.eta).toBe(0);
    expect(end.when).toBeGreaterThan(0);
  });
});
