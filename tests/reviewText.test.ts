// The game review's words and graph (src/ui/reviewText.ts) and its runner (src/ui/reviewRun.ts).
import { describe, expect, it, vi } from 'vitest';
import { chooseMove, createGame, move, moveEvent, replay, roll, rollEvent, seeded, seededDie, type GameRecord, type GameState, type Seat } from '../src/engine';
import { positionKey } from '../src/engine/rng';
import { REVIEW_VERSION, accuracyOf, luckPercent, summary, type DecisionValues, type MoveReview, type ReviewAsk, type Reviewer } from '../src/engine/ai/review';
import { verdictText, bigRolls, etaText, evenChance, graphPoints, keyMoves, moveText, reviewedText, rollText, verdictMoves, whichToken, headline, turningPoint, accuracyText, FEW_BIG_DECISIONS, plainVerdict, BETTER_COLOR, LABEL_LOOK, type VerdictPart, runningAccuracy, runningLuck, trendOf, ACCURACY_LINE_FROM, TREND_GAMES } from '../src/ui/reviewText';
import type { Move } from '../src/engine';

const mem = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: mem.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => void mem.set(key, value),
    remove: async ({ key }: { key: string }) => void mem.delete(key),
  },
}));
vi.mock('../src/engine/ai/review-worker', () => ({ workerReviewer: () => null, workerLuck: () => Promise.resolve({ luck: [], chances: [] }) }));
const { runReview, decisionsToReview, LUCK_AFTER_KEYS, LUCK_AFTER_SHARE } = await import('../src/ui/reviewRun');
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
    expect(rollText(r[0]!, 'Aarav', false)).toBe('Aarav: +15% to win');
    expect(rollText(r[1]!, 'You', true)).toBe('−12% to win');
  });
});

describe('luck %, headline and turning point', () => {
  it('tells the story of the game', () => {
    expect(headline({ won: false, accuracy: 0.92, name: 'You' })).toBe('You played well: the turning point decided it.');
    expect(headline({ won: true, accuracy: 0.95, name: 'You' })).toBe('Won on great play.');
    expect(headline({ won: true, accuracy: 0.8, name: 'You' })).toBe('Won, with a few slips to learn from.');
    expect(headline({ won: false, accuracy: 0.7, name: 'Aarav' })).toBe('Lost on mistakes: the key moves show where.');
    expect(headline({ won: false, accuracy: 0.6, name: 'You', keyMistakes: 0, inaccuracies: 7 })).toBe('No big mistakes, but small slips added up in close decisions.');
    expect(headline({ won: false, accuracy: 0.8, name: 'You', keyMistakes: 0, inaccuracies: 3 })).toBe('Lost on 3 small slips: the key moves show where.');
    const blunder = { at: 9, owner: 0, played: 0, best: 1, playedChance: 0.1, bestChance: 0.4, gap: 32, se: 1, label: 'blunder' } as MoveReview;
    expect(headline({ won: false, accuracy: 0.92, name: 'You', decider: blunder })).toBe('One blunder decided it: a single move gave up 32% to win.');
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
  // Every decision's spread under 3 points, and only Best or Good moves: little at stake, nothing labelled worse.
  const mv = (at: number, label: MoveReview['label'], gap: number): MoveReview => ({ at, owner: 0, played: 1, best: 0, playedChance: 0.3, bestChance: 0.32, gap, se: 0.4, label, gaps: [0, gap, 2.5] });
  const moves = [mv(1, 'best', 0), mv(2, 'good', 1.2), mv(3, 'good', 1.6), mv(4, 'best', 0)];
  it('has no accuracy, shown as a dash with the explainer, and never as NaN%', () => {
    const s = summary(moves, [], 2)[0]!;
    expect(s.accuracy).toBeNaN();
    expect(accuracyText(s.accuracy)).toBe('–');
    expect(FEW_BIG_DECISIONS).toMatch(/^Few big decisions/);
    expect(accuracyText(0.873)).toBe('87%');
    // The counts still show.
    expect(s.labels.good).toBe(2);
    expect(s.keyMistakes).toBe(0);
  });
  it('counts Inaccuracies even in small decisions, so they never leave a dash or a 100% (#133)', () => {
    const s = summary([mv(1, 'best', 0), mv(2, 'inaccuracy', 2.2), mv(3, 'good', 1.6), mv(4, 'inaccuracy', 2)], [], 2)[0]!;
    expect(Number.isFinite(s.accuracy)).toBe(true);
    expect(s.accuracy).toBeLessThan(0.99 + 1e-9);
    expect(s.labels.inaccuracy).toBe(2);
  });
  it('never judges the dice in words (#152)', () => {
    for (const won of [true, false])
      for (const accuracy of [0.5, 0.8, 0.95, NaN])
        for (const keyMistakes of [0, 2])
          expect(headline({ won, accuracy, name: 'You', keyMistakes, inaccuracies: 3 })).not.toMatch(/luck|dice|kind/i);
  });
  it('gets a headline that quotes no accuracy', () => {
    for (const won of [true, false]) {
      const h = headline({ won, accuracy: NaN, name: 'You', keyMistakes: 0, inaccuracies: 2 });
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
    // Every other move 10.5 points down: away from every label's edge, so one call per decision (the
    // stakes order's net screen, which this fake doesn't do, isn't counted).
    const fake = async (s: GameState, _n: number, _seed: number, ask?: ReviewAsk): Promise<DecisionValues> => {
      if (ask?.mode !== 'screen') calls++;
      return { ofMove: s.moves.map((_, i) => i), mean: s.moves.map((_, i) => (i ? 0.595 : 0.7)), gap: s.moves.map((_, i) => (i ? 0.105 : 0)), se: s.moves.map(() => 0.01), best: 0 };
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

  it('runs the luck pass after the first key verdicts, or a third of the decisions, and once for a short review (#93)', async () => {
    const rec = game(9);
    const total = decisionsToReview(rec, replay(rec).states);
    // gap: what every move but the first gives up (0.075: a mistake; 0: all Best, no key moves).
    const fakeWith = (gap: number) => async (s: GameState, _n: number, _seed: number, ask?: ReviewAsk): Promise<DecisionValues> =>
      ({ ofMove: s.moves.map((_, i) => i), mean: s.moves.map((_, i) => (i ? 0.5 - gap : 0.5)), gap: s.moves.map((_, i) => (i ? gap : 0)), se: s.moves.map(() => 0.01), best: 0, ...(ask?.mode === 'screen' ? { kind: 'screen' as const } : {}) });
    const run = (gap: number, stored?: Parameters<typeof runReview>[1]) => {
      let last: MoveReview[] = [];
      const starts: { verdicts: number; keys: number }[] = [];
      const luckOf = () => {
        // The verdicts and key verdicts the screen had when the luck pass started.
        starts.push({ verdicts: last.length - (stored?.moves.length ?? 0), keys: last.filter((m) => m.label === 'mistake' || m.label === 'blunder').length });
        return Promise.resolve({ luck: [], chances: [] });
      };
      return new Promise<{ starts: typeof starts; moves: MoveReview[]; luck: unknown }>((done) =>
        runReview(rec, stored, (p) => {
          last = p.moves;
          if (p.finished) done({ starts, moves: p.moves, luck: p.luck });
        }, false, fakeWith(gap), undefined, luckOf),
      );
    };
    // With key moves: on the second one, before a third of the decisions.
    const keyed = await run(0.075);
    expect(keyed.starts).toHaveLength(1);
    expect(keyed.starts[0]!.keys).toBe(LUCK_AFTER_KEYS);
    expect(keyed.starts[0]!.verdicts).toBeLessThan(Math.ceil(total * LUCK_AFTER_SHARE));
    expect(keyed.luck).toEqual([]);
    // No key moves at all: after a third of the decisions.
    const clean = await run(0);
    expect(clean.starts).toEqual([{ verdicts: Math.ceil(total * LUCK_AFTER_SHARE), keys: 0 }]);
    // Two decisions left: once (after the first, a third of two rounded up), and the review finishes with luck.
    const short = await run(0, { v: REVIEW_VERSION, moves: clean.moves.slice(0, clean.moves.length - 2), luck: null });
    expect(short.starts).toHaveLength(1);
    expect(short.luck).toEqual([]);
  });

  it('reports the decision with the most at stake first (the net screen orders them, #101)', async () => {
    const rec = game(9);
    // The net's spread grows with the decision's index, so the last decision has the most at stake. (The
    // runner replays the game itself, so its states are found by position.)
    const index = new Map(replay(rec).states.map((s, i) => [positionKey(s), i]));
    const stake = (s: GameState) => index.get(positionKey(s))! / 1000;
    const fake: Reviewer = async (s, _n, _seed, ask) => {
      const ofMove = s.moves.map((_, i) => i);
      if (ask?.mode === 'screen') return { ofMove, mean: ofMove.map((i) => (i ? 0.5 - stake(s) : 0.5)), gap: ofMove.map((i) => (i ? stake(s) : 0)), se: ofMove.map(() => 0), best: 0, kind: 'screen' };
      return { ofMove, mean: ofMove.map((i) => (i ? 0.425 : 0.5)), gap: ofMove.map((i) => (i ? 0.075 : 0)), se: ofMove.map(() => 0.01), best: 0 };
    };
    const order: number[] = [];
    const all = await new Promise<MoveReview[]>((done) =>
      runReview(rec, undefined, (p) => {
        if (p.moves.length > order.length) order.push(p.moves.map((m) => m.at).find((at) => !order.includes(at))!);
        if (p.finished) done(p.moves);
      }, false, fake),
    );
    expect(all.length).toBeGreaterThan(5);
    expect(order[0]).toBe(Math.max(...all.map((m) => m.at)));
    expect(order).toEqual([...order].sort((a, b) => b - a));
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

describe('plain verdicts (#124)', () => {
  const mv = (o: Partial<Move>): Move => ({ kind: 'single', color: 'blue', tokens: [0], from: 10, to: 13, steps: 3, roll: 3, captures: [], finishes: 0, ...o }) as Move;
  const text = (parts: VerdictPart[]) => parts.map((p) => (typeof p === 'string' ? p : `[${p.pill}:${p.text}]`)).join('');
  const say = (played: Move, best: Move, label: 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder' = 'mistake', gap = 8, who = 'You') =>
    plainVerdict({ label, played: 0, best: 1, gap }, { moves: [played, best] }, who);

  it('titles a verdict in the one unit the review uses: % to win (#152)', () => {
    const s = { moves: [mv({})], players: [] } as unknown as GameState;
    const head = (label: MoveReview['label'], gap: number) => verdictText({ label, played: 0, best: 0, gap } as MoveReview, s, 'You').head;
    expect(head('mistake', 7.6)).toBe('Mistake: −8% to win');
    expect(head('inaccuracy', 2.2)).toBe('Inaccuracy: −2% to win');
    expect(head('best', 0)).toBe('Best');
  });
  it('names the better move that gets a token home', () => {
    expect(text(say(mv({ steps: 3 }), mv({ tokens: [1], steps: 6, finishes: 1 }), 'blunder', 19).parts)).toBe('You moved [you:this token] 3. Moving [better:that one] 6 gets it home.');
  });
  it('names a capture', () => {
    expect(text(say(mv({}), mv({ tokens: [2], steps: 4, captures: [{ color: 'red', token: 0 }] as Move['captures'] })).parts)).toBe('You moved [you:this token] 3. Moving [better:that one] 4 captures.');
  });
  it('brings a token out, either way round', () => {
    expect(text(say(mv({}), mv({ kind: 'release', tokens: [3] })).parts)).toBe('You moved [you:this token] 3. [better:Bringing a new one out] was better.');
    expect(text(say(mv({ kind: 'release', tokens: [3] }), mv({ steps: 6 })).parts)).toBe('You brought a new token out. Moving [better:that one] 6 was better.');
  });
  it('says pair for a pair', () => {
    expect(text(say(mv({ kind: 'pair', tokens: [0, 1], steps: 1 }), mv({ tokens: [2], steps: 2 }), 'inaccuracy', 2).parts)).toBe('You moved [you:this pair] 1. Moving [better:that one] 2 was better.');
    expect(text(say(mv({ tokens: [2], steps: 2 }), mv({ kind: 'pair', tokens: [0, 1], steps: 1 })).parts)).toBe('You moved [you:this token] 2. Moving [better:that pair] 1 was better.');
  });
  it('says "it" when the better move is the same token by another die', () => {
    expect(text(say(mv({ steps: 2 }), mv({ steps: 5 })).parts)).toBe('You moved [you:this token] 2. Moving [better:it] 5 was better.');
  });
  it('uses the player name, and says what the played move did', () => {
    expect(text(say(mv({ steps: 4, finishes: 1 }), mv({ tokens: [1], steps: 6 }), 'mistake', 6, 'Aarav').parts)).toBe('Aarav moved [you:this token] 4 home. Moving [better:that one] 6 was better.');
    expect(text(say(mv({ captures: [{ color: 'red', token: 1 }] as Move['captures'] }), mv({ tokens: [1], steps: 6 })).parts)).toBe('You moved [you:this token] 3, capturing. Moving [better:that one] 6 was better.');
  });
  it('a Best move: no better move and no win chance', () => {
    const v = plainVerdict({ label: 'best', played: 0, best: 0, gap: 0 }, { moves: [mv({})] }, 'You');
    expect(text(v.parts)).toBe('You found the best move.');
    expect(v.better).toBe(false);
    expect(v.win).toBeNull();
  });
  it('the win chance: always +N in the better colour on Inaccuracy, Mistake and Blunder; never on Best or Good', () => {
    for (const [label, gap, want] of [['inaccuracy', 2.4, '+2% to win'], ['mistake', 7.6, '+8% to win'], ['blunder', 19.2, '+19% to win']] as const) {
      const v = say(mv({}), mv({ tokens: [1] }), label, gap);
      expect(v.win).toEqual({ text: want, color: BETTER_COLOR });
      expect(v.win!.text.startsWith('+')).toBe(true);
      expect(v.name).toBe(LABEL_LOOK[label].name);
      expect(v.color).toBe(LABEL_LOOK[label].color);
    }
    expect(say(mv({}), mv({ tokens: [1] }), 'good', 1.2).win).toBeNull();
    expect(say(mv({}), mv({ tokens: [1] }), 'good', 1.2).better).toBe(true);
    // A gap that rounds to 0 still says +1: the better move was better.
    expect(say(mv({}), mv({ tokens: [1] }), 'inaccuracy', 0.3).win!.text).toBe('+1% to win');
  });
});

describe('accuracy and luck graphs (#134)', () => {
  const mv = (at: number, label: MoveReview['label'], gap: number, spread: number): MoveReview => ({ at, owner: 0, played: 1, best: 0, playedChance: 0.5, bestChance: 0.5, gap, se: 0.2, label, gaps: [0, gap, spread] });
  it("running accuracy: from the first counted decision, solid from the 5th (the split index), ending at the game's accuracy", () => {
    const mine = [mv(1, 'good', 1, 1.5), mv(2, 'best', 0, 8), mv(3, 'mistake', 7, 9), mv(4, 'best', 0, 6), mv(5, 'best', 0, 12), mv(6, 'inaccuracy', 3, 4), mv(7, 'best', 0, 5)];
    const { values, solidFrom } = runningAccuracy(mine);
    // The Good move in a 1.5-point decision doesn't count: no value there. Counted: moves at index 1, 2, 3, 4, 5, 6.
    expect(values[0]).toBeNull();
    expect(values.slice(1).every((x) => x !== null)).toBe(true);
    expect(solidFrom).toBe(5); // the 5th counted decision
    expect(values.at(-1)).toBeCloseTo(accuracyOf(mine), 12);
    expect(ACCURACY_LINE_FROM).toBe(5);
  });
  it('running accuracy with fewer than 5 counted decisions: all faded, still ending at the card figure', () => {
    const mine = [mv(1, 'best', 0, 8), mv(2, 'mistake', 7, 9), mv(3, 'good', 1, 1.2)];
    const { values, solidFrom } = runningAccuracy(mine);
    expect(solidFrom).toBe(mine.length);
    expect(values.at(-1)).toBeCloseTo(accuracyOf(mine), 12);
  });
  it("running luck ends at the card's luck, one point per roll that has a luck, never NaN", () => {
    const r = (at: number, owner: number, luck: number, sd?: number) => ({ at, owner, face: 3, luck, ...(sd === undefined ? {} : { sd }) });
    const luck = [r(5, 0, 4, 8), r(2, 0, -3, 6), r(9, 1, 2, 5), r(12, 0, 1, 4)];
    const pts = runningLuck(luck, 0);
    expect(pts.map((p) => p.at)).toEqual([2, 5, 12].filter((at) => Number.isFinite(luckPercent(luck.filter((l) => l.owner === 0 && l.at <= at), 0))));
    expect(pts.every((p) => Number.isFinite(p.pct))).toBe(true);
    expect(pts.at(-1)!.pct).toBeCloseTo(luckPercent(luck, 0), 9);
  });
  it('the trend: the last 10 games, oldest first, averages over games that have one; none under 2 games', () => {
    const g = (accuracy: number, luckPct: number) => ({ accuracy, luckPct });
    const games = Array.from({ length: 12 }, (_, i) => g(0.5 + i / 100, 40 + i));
    const t = trendOf(games)!;
    expect(t.games).toHaveLength(TREND_GAMES);
    expect(t.games[0]).toEqual(games[2]);
    expect(t.accuracy).toBeCloseTo((0.52 + 0.61) / 2, 9);
    expect(trendOf([g(0.8, 50), g(NaN, 60)])!.accuracy).toBeCloseTo(0.8, 9);
    expect(trendOf([g(0.8, 50)])).toBeNull();
  });
});
