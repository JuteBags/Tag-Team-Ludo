// The game review's words and graph (src/ui/reviewText.ts) and its runner (src/ui/reviewRun.ts).
import { describe, expect, it, vi } from 'vitest';
import { chooseMove, createGame, move, moveEvent, replay, roll, rollEvent, seeded, seededDie, type GameRecord, type GameState, type Seat } from '../src/engine';
import { REVIEW_VERSION, summary, type DecisionValues, type MoveReview } from '../src/engine/ai/review';
import { bigRolls, etaText, evenChance, graphPoints, keyMoves, luckWords, moveText, reviewedText, rollText, verdictMoves, whichToken, luckBand, headline, turningPoint, accuracyText, FEW_BIG_DECISIONS } from '../src/ui/reviewText';

const mem = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: mem.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => void mem.set(key, value),
    remove: async ({ key }: { key: string }) => void mem.delete(key),
  },
}));
vi.mock('../src/engine/ai/review-worker', () => ({ workerReviewer: () => null, workerLuck: () => Promise.resolve({ luck: [], chances: [] }) }));
const { runReview, decisionsToReview } = await import('../src/ui/reviewRun');
const { loadReview, savePastGame, loadPastGames, reviewKey, KEEP_GAMES } = await import('../src/ui/store');

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

describe('which token', () => {
  const s = { players: [{ color: 'blue', owner: 0, bot: false, tokens: [-1, 30, 12, 56] }, { color: 'red', owner: 1, bot: true, tokens: [5, -1, -1, -1] }] } as never;
  const mv = (tokens: number[], steps: number) => ({ kind: 'normal', color: 'blue', tokens, from: 0, to: 0, steps, roll: steps, captures: [], finishes: 0 }) as never;
  it('names the token only when the played and best moves would read the same', () => {
    expect(whichToken(s, mv([1], 4))).toBe('front');
    expect(whichToken(s, mv([2], 4))).toBe('back');
    expect(verdictMoves(s, mv([2], 4), mv([1], 4))).toEqual(['moved the back token 4', 'moved the front token 4']);
    expect(verdictMoves(s, mv([2], 4), mv([1], 2))).toEqual(['moved 4', 'moved 2']);
    // The same die, one capturing: still both named, and who is captured.
    const cap = { ...(mv([1], 4) as object), captures: [{ color: 'red', token: 0 }] } as never;
    expect(verdictMoves(s, mv([2], 4), cap, () => 'Aarav')).toEqual(['moved the back token 4', 'moved the front token 4, capturing Aarav']);
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

describe('luck %, headline and turning point', () => {
  it('puts a luck percentile into bands', () => {
    expect([10, 25, 50, 70, 95].map((p) => luckBand(p).word)).toEqual(['unlucky', 'a bit unlucky', 'average', 'a bit lucky', 'lucky']);
  });
  it('tells the story of the game', () => {
    expect(headline({ won: false, accuracy: 0.92, luckPct: 12, name: 'You' })).toBe('You played well (92%), but the dice went against you (luck 12%).');
    expect(headline({ won: true, accuracy: 0.95, luckPct: 50, name: 'You' })).toBe('Won on great play: 95% accuracy.');
    expect(headline({ won: false, accuracy: 0.7, luckPct: 50, name: 'Aarav' })).toBe('Lost on mistakes: the key moves show where.');
    expect(headline({ won: false, accuracy: 0.6, luckPct: 98, name: 'You', keyMistakes: 0, inaccuracies: 7 })).toBe('No big mistakes, but small slips added up in close decisions.');
    expect(headline({ won: false, accuracy: 0.8, luckPct: 98, name: 'You', keyMistakes: 0, inaccuracies: 3 })).toBe('The dice were kind (luck 98%), but 3 small slips added up.');
    const blunder = { at: 9, owner: 0, played: 0, best: 1, playedChance: 0.1, bestChance: 0.4, gap: 32, se: 1, label: 'blunder' } as MoveReview;
    expect(headline({ won: false, accuracy: 0.92, luckPct: 70, name: 'You', decider: blunder })).toBe('One blunder decided it: a single move cost 32 points of winning chance.');
  });
  it('finds the biggest swing, a move or a roll', () => {
    const mv = (at: number, gap: number): MoveReview => ({ at, owner: 0, played: 0, best: 1, playedChance: 0.5, bestChance: 0.5, gap, se: 0.5, label: 'mistake' });
    const r = (at: number, luck: number) => ({ at, owner: 1, face: 6, luck });
    expect(turningPoint([mv(3, 12), mv(5, 4), mv(9, 1)], [r(2, 9), r(8, 2)], 0)).toMatchObject({ kind: 'move', move: { at: 3 } });
    expect(turningPoint([mv(3, 6), mv(9, 1)], [r(2, -15), r(8, 2)], 0)).toMatchObject({ kind: 'roll', roll: { at: 2 } });
    expect(turningPoint([], [], 0)).toBeNull();
    // The last roll (the one that ends the game) never counts, nor a swing once the game was decided.
    expect(turningPoint([mv(3, 2), mv(9, 1)], [r(2, 1.5), r(8, 40)], 0)).toMatchObject({ kind: 'move', move: { at: 3 } });
    expect(turningPoint([mv(3, 2), mv(9, 1)], [r(2, 30), r(8, 1)], 0, (at) => (at === 2 ? 0.04 : 0.5))).toMatchObject({ kind: 'move', move: { at: 3 } });
  });
});

describe('a game with no meaningful decision', () => {
  // Every decision's spread under 3 points: small slips in decisions where little was at stake.
  const mv = (at: number, label: MoveReview['label'], gap: number): MoveReview => ({ at, owner: 0, played: 1, best: 0, playedChance: 0.3, bestChance: 0.32, gap, se: 0.4, label, gaps: [0, gap, 2.5] });
  const moves = [mv(1, 'best', 0), mv(2, 'inaccuracy', 2.2), mv(3, 'good', 1.6), mv(4, 'inaccuracy', 2)];
  it('has no accuracy, shown as a dash with the explainer, and never as NaN%', () => {
    const s = summary(moves, [], 2)[0]!;
    expect(s.accuracy).toBeNaN();
    expect(accuracyText(s.accuracy)).toBe('–');
    expect(FEW_BIG_DECISIONS).toMatch(/^Few big decisions/);
    expect(accuracyText(0.873)).toBe('87%');
    // The counts still show.
    expect(s.labels.inaccuracy).toBe(2);
    expect(s.keyMistakes).toBe(0);
  });
  it('gets a headline that quotes no accuracy', () => {
    for (const won of [true, false])
      for (const luckPct of [10, 50, 90]) {
        const h = headline({ won, accuracy: NaN, luckPct, name: 'You', keyMistakes: 0, inaccuracies: 2 });
        expect(h).not.toMatch(/NaN/);
        expect(h).not.toMatch(/played well|great play|\d+% accuracy/);
      }
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
    // Every other move 7.5 points down: away from every label's edge, so one call per decision.
    const fake = async (s: GameState): Promise<DecisionValues> => {
      calls++;
      return { ofMove: s.moves.map((_, i) => i), mean: s.moves.map((_, i) => (i ? 0.425 : 0.5)), gap: s.moves.map((_, i) => (i ? 0.075 : 0)), se: s.moves.map(() => 0.01), best: 0 };
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

  it('a stopped run never saves over a newer run of the same game, even when its last call resolves last', async () => {
    mem.clear();
    const rec = game(12);
    await savePastGame({ rec, at: 1, mode: 'pvc', place: 2 });
    const values = (s: GameState): DecisionValues => ({ ofMove: s.moves.map((_, i) => i), mean: s.moves.map((_, i) => (i ? 0.425 : 0.5)), gap: s.moves.map((_, i) => (i ? 0.075 : 0)), se: s.moves.map(() => 0.01), best: 0 });
    // Run 1: its third decision hangs until we let it go.
    let calls = 0;
    let release!: () => void;
    const slow = (s: GameState) => {
      calls++;
      return calls === 3 ? new Promise<DecisionValues>((r) => (release = () => r(values(s)))) : Promise.resolve(values(s));
    };
    const stop1 = runReview(rec, undefined, () => {}, true, slow);
    for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setTimeout(r, 1));
    expect(release).toBeTypeOf('function');
    stop1();
    // Run 2 starts at once and finishes the whole review.
    const done2 = await new Promise<number>((done) => runReview(rec, undefined, (p) => p.finished && done(p.moves.length), true, async (s) => values(s)));
    // Run 1's hanging call resolves last: nothing it does may reach storage.
    release();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 2));
    const stored = await loadReview(rec);
    expect(stored?.done).toBe(true);
    expect(stored?.moves.length).toBe(done2);
  });

  it('keeps reviews apart from the games list, and drops a review with its game', async () => {
    mem.clear();
    const first = game(20);
    await savePastGame({ rec: first, at: 0, mode: 'pvc', place: 1 });
    await new Promise<void>((done) => runReview(first, undefined, (p) => p.finished && done(), true, async (s) => ({ ofMove: s.moves.map(() => 0), mean: [0.5], gap: [0], se: [0], best: 0 })));
    expect(mem.has(reviewKey(first))).toBe(true);
    expect((await loadPastGames())[0]!.review).toBeUndefined();
    // KEEP_GAMES newer games push it off the list: its review goes too.
    for (let i = 0; i < KEEP_GAMES; i++) await savePastGame({ rec: { ...first, seed: 1000 + i }, at: i + 1, mode: 'pvc', place: 1 });
    expect(mem.has(reviewKey(first))).toBe(false);
  });

  it('counts decisions with nothing to choose as done, so a review finishes', async () => {
    const rec = game(9);
    let k = 0;
    // Every third decision: all its moves reach the same position (one candidate).
    const fake = async (s: GameState): Promise<DecisionValues> =>
      k++ % 3 === 0
        ? { ofMove: s.moves.map(() => 0), mean: [0.5], gap: [0], se: [0], best: 0 }
        : { ofMove: s.moves.map((_, i) => i), mean: s.moves.map((_, i) => (i ? 0.425 : 0.5)), gap: s.moves.map((_, i) => (i ? 0.075 : 0)), se: s.moves.map(() => 0.01), best: 0 };
    const end = await new Promise<{ done: number; total: number; moves: MoveReview[] }>((done) => runReview(rec, undefined, (p) => p.finished && done(p), false, fake));
    expect(end.done).toBe(end.total);
    expect(end.moves.length).toBeLessThan(end.total);
  });

  it('estimates the time left once a few verdicts are in, and dates the finished review', async () => {
    const rec = game(9);
    const fake = async (s: GameState): Promise<DecisionValues> => ({ ofMove: s.moves.map((_, i) => i), mean: s.moves.map((_, i) => (i ? 0.425 : 0.5)), gap: s.moves.map((_, i) => (i ? 0.075 : 0)), se: s.moves.map(() => 0.01), best: 0 });
    const seen: (number | null)[] = [];
    const end = await new Promise<{ when?: number; eta: number | null }>((done) =>
      runReview(rec, undefined, (p) => (p.finished ? done(p) : seen.push(p.eta)), false, fake),
    );
    expect(seen.slice(0, 6).every((e) => e === null)).toBe(true);
    expect(seen.at(-1)).not.toBeNull();
    expect(end.eta).toBe(0);
    expect(end.when).toBeGreaterThan(0);
  });
});
