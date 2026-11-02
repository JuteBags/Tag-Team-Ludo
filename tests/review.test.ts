// The game review (src/engine/ai/review.ts): labels from the win chance given up, verdicts only for real
// choices, more playouts near a label's edge, and luck that averages to zero.
import { describe, expect, it } from 'vitest';
import { chooseMove, createGame, move, moveEvent, replay, roll, rollEvent, seeded, seededDie, type GameRecord, type GameState, type Seat } from '../src/engine';
import { HARD_RULES } from '../src/engine/ai/hard-rules';
import { LinearRules } from '../src/engine/ai/linear';
import { faceChances, labelOf, PLAYOUTS, reviewMoves, rollLuck, SKIP_BELOW, summary, type DecisionValues, type Label, type Reviewer, type ReviewAsk } from '../src/engine/ai/review';

const SEATS: Seat[] = [
  { color: 'blue', owner: 0, bot: false },
  { color: 'red', owner: 1, bot: true, level: 'hard' },
];

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

describe('accuracy', () => {
  it('weighs each label: a blunder costs more than an inaccuracy', () => {
    const m = (label: Label) => ({ at: 0, owner: 0, played: 0, best: 0, playedChance: 0, bestChance: 0, gap: 0, se: 0, label });
    expect(summary([m('best'), m('good')], [], 1)[0]!.accuracy).toBeCloseTo(0.95, 9);
    expect(summary([m('best'), m('blunder')], [], 1)[0]!.accuracy).toBeCloseTo(0.5, 9);
    expect(summary([m('inaccuracy'), m('mistake')], [], 1)[0]!.accuracy).toBeCloseTo(0.45, 9);
  });
});

describe('labels', () => {
  it('calls a move best within 1.5 points or one standard error of the top, then by the points given up', () => {
    expect(labelOf(0, 0)).toBe('best');
    expect(labelOf(1.4, 0.2)).toBe('best');
    expect(labelOf(2.5, 3)).toBe('best');
    expect(labelOf(2.5, 0.5)).toBe('good');
    expect(labelOf(5, 0.5)).toBe('inaccuracy');
    expect(labelOf(10, 1)).toBe('mistake');
    expect(labelOf(15, 1)).toBe('blunder');
  });
});

describe('move review', () => {
  it("reviews only the person's real choices, and tops up decisions near a label's edge", async () => {
    const rec = game(3);
    const { states } = replay(rec) as { states: GameState[] };
    const calls: number[] = [];
    // A fake engine: the first move is best, every other one 6.5 points worse (near the 7-point edge).
    const fake = async (s: GameState, n: number): Promise<DecisionValues> => {
      calls.push(n);
      const k = s.moves.length;
      return { ofMove: s.moves.map((_, i) => i), mean: Array.from({ length: k }, (_, i) => (i ? 0.435 : 0.5)), gap: Array.from({ length: k }, (_, i) => (i ? 0.065 : 0)), se: new Array(k).fill(0.01), best: 0 };
    };
    const seen: number[] = [];
    const out = await reviewMoves(rec, states, [0], fake, (_, done) => seen.push(done));
    expect(out.length).toBeGreaterThan(5);
    expect(seen).toEqual(out.map((_, i) => i + 1));
    for (const m of out) {
      const s = states[m.at]!;
      expect(s.players[s.current]!.owner).toBe(0);
      expect(s.moves.length).toBeGreaterThan(1);
      expect(m.label).toBe(m.played === 0 ? 'best' : 'inaccuracy');
    }
    // A played move off the best, 6.5 points down, sits within 2 of the 7 edge: it gets up to 1024 playouts.
    expect(calls).toContain(PLAYOUTS * 4);
    expect(calls.filter((n) => n === PLAYOUTS).length).toBe(out.length);
  });

  it('is the same every time for the same game (fixed seeds per decision)', async () => {
    const rec = game(4);
    const { states } = replay(rec) as { states: GameState[] };
    const seeds: number[][] = [[], []];
    for (const run of [0, 1])
      await reviewMoves(rec, states, [0], async (s, _n, seed) => {
        seeds[run]!.push(seed);
        return { ofMove: s.moves.map(() => 0), mean: [0.5], gap: [0], se: [0], best: 0 };
      });
    expect(seeds[0]).toEqual(seeds[1]);
    expect(new Set(seeds[0]).size).toBe(seeds[0]!.length);
  });
});

describe('fast review (#101)', () => {
  // A fake fast engine: the race outcome per decision comes from `kind(at)`; the screen's spread from `spread(at)`.
  function fakeFast(states: GameState[], kind: (at: number) => 'net' | 'best' | 'worse', spread: (at: number) => number = () => 0.1) {
    const asks: { at: number; n: number; ask?: ReviewAsk }[] = [];
    const reviewer: Reviewer = async (s, n, _seed, ask) => {
      const at = states.indexOf(s);
      asks.push({ at, n, ask });
      const k = s.moves.length;
      const ofMove = s.moves.map((_, i) => i);
      if (ask?.mode === 'screen') return { ofMove, mean: ofMove.map((i) => (i ? 0.5 - spread(at) : 0.5)), gap: ofMove.map((i) => (i ? spread(at) : 0)), se: ofMove.map(() => 0), best: 0, kind: 'screen' };
      const kd = ask ? kind(at) : 'full';
      if (kd === 'net') return { ofMove, mean: ofMove.map(() => 0.5), gap: ofMove.map(() => 0.004), se: ofMove.map(() => 0), best: 0, kind: 'net' };
      // Move 0 is best (the played one when the race settled it as Best); the others 6.5 points worse (near
      // the 7-point edge, so a full review tops them up).
      const top = kd === 'best' && ask?.mode === 'race' ? ask.played : 0;
      return { ofMove, mean: ofMove.map((i) => (i !== top ? 0.435 : 0.5)), gap: ofMove.map((i) => (i !== top ? 0.065 : 0)), se: new Array(k).fill(0.01), best: top, kind: kd, complete: kd !== 'best' };
    };
    return { reviewer, asks };
  }

  it('takes a settled Best from the race and a net skip with no playouts; anything else is the full review with its top-ups', async () => {
    const rec = game(6);
    const { states } = replay(rec) as { states: GameState[] };
    const kinds = ['net', 'best', 'worse'] as const;
    const { reviewer, asks } = fakeFast(states, (at) => kinds[at % 3]!);
    const out = await reviewMoves(rec, states, [0], reviewer);
    expect(out.length).toBeGreaterThan(5);
    for (const m of out) {
      const kd = kinds[m.at % 3]!;
      const mine = asks.filter((a) => a.at === m.at);
      expect(mine[0]!.ask).toEqual({ mode: 'race', played: m.played, skip: SKIP_BELOW });
      expect(mine[0]!.n).toBe(PLAYOUTS);
      if (kd === 'net') {
        expect(m).toMatchObject({ label: 'best', gap: 0, approx: 'net' });
        expect(m.gaps).toEqual(states[m.at]!.moves.map(() => 0));
        expect(mine.length).toBe(1);
      } else if (kd === 'best') {
        expect(m.label).toBe('best');
        expect(m.approx).toBe('race');
        expect(Math.max(...m.gaps!)).toBeCloseTo(6.5, 6);
        expect(mine.length).toBe(1);
      } else {
        expect(m.approx).toBeUndefined();
        expect(m.label).toBe(m.played === 0 ? 'best' : 'inaccuracy');
        // Top-ups are plain full reviews (no ask), as before.
        if (m.played !== 0) expect(mine.slice(1).map((a) => [a.n, a.ask])).toEqual([[PLAYOUTS * 2, undefined], [PLAYOUTS * 4, undefined], [PLAYOUTS * 8, undefined]]);
      }
    }
  });

  it('with fast off, asks only for full reviews', async () => {
    const rec = game(6);
    const { states } = replay(rec) as { states: GameState[] };
    const { reviewer, asks } = fakeFast(states, () => 'best');
    const out = await reviewMoves(rec, states, [0], reviewer, undefined, undefined, undefined, { fast: false });
    expect(out.every((m) => m.approx === undefined)).toBe(true);
    expect(asks.every((a) => a.ask === undefined)).toBe(true);
  });

  it("orders by the net's stakes when asked: the biggest first, and skips below the threshold without a race", async () => {
    const rec = game(7);
    const { states } = replay(rec) as { states: GameState[] };
    const spread = (at: number) => ((at * 37) % 100) / 1000; // 0 to 9.9 points
    const { reviewer, asks } = fakeFast(states, () => 'worse', spread);
    const order: number[] = [];
    const out = await reviewMoves(rec, states, [0], reviewer, (m) => order.push(m.at), undefined, undefined, { order: 'stakes' });
    const stakes = order.map((at) => spread(at));
    expect(stakes).toEqual([...stakes].sort((a, b) => b - a));
    for (const m of out) {
      const raced = asks.some((a) => a.at === m.at && a.ask?.mode === 'race');
      expect(raced).toBe(100 * spread(m.at) >= SKIP_BELOW);
      if (!raced) expect(m.approx).toBe('net');
    }
    // The race isn't asked to screen again.
    expect(asks.filter((a) => a.ask?.mode === 'race').every((a) => a.ask?.mode === 'race' && a.ask.skip === 0)).toBe(true);
  });
});

describe('luck', () => {
  it("uses the chances the app's dice gave each roll", () => {
    const rec = game(5);
    const { states } = replay(rec) as { states: GameState[] };
    for (let i = 0; i < 200; i++) {
      const s = states[i]!;
      if (s.phase !== 'roll') continue;
      const p = faceChances(rec, s);
      expect(p.reduce((a, x) => a + x, 0)).toBeCloseTo(1, 9);
      expect(p[states[i + 1]!.dice! - 1]!).toBeGreaterThan(0);
    }
  });

  it('averages to zero over many rolls, and sums per person', () => {
    const net = new LinearRules(HARD_RULES);
    let sum = 0;
    let sq = 0;
    let n = 0;
    for (let seed = 10; seed < 22; seed++) {
      const rec = game(seed);
      const { states } = replay(rec) as { states: GameState[] };
      const luck = rollLuck(rec, states, net);
      for (const l of luck) {
        sum += l.luck;
        sq += l.luck * l.luck;
        n++;
      }
      const sm = summary([], luck, 2);
      expect(sm[0]!.luck + sm[1]!.luck).toBeCloseTo(luck.reduce((a, l) => a + l.luck, 0), 6);
    }
    const mean = sum / n;
    const se = Math.sqrt((sq / n - mean * mean) / n);
    expect(n).toBeGreaterThan(1000);
    expect(Math.abs(mean)).toBeLessThan(3 * se + 0.05);
  }, 120_000);
});
