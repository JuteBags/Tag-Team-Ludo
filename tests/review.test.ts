// The game review (src/engine/ai/review.ts): labels from the win chance given up, verdicts only for real
// choices, more playouts near a label's edge, and luck that averages to zero.
import { describe, expect, it } from 'vitest';
import { chooseMove, createGame, move, moveEvent, replay, roll, rollEvent, seeded, seededDie, type GameRecord, type GameState, type Seat } from '../src/engine';
import { HARD_RULES } from '../src/engine/ai/hard-rules';
import { LinearRules } from '../src/engine/ai/linear';
import { faceChances, labelOf, PLAYOUTS, reviewMoves, rollLuck, summary, type DecisionValues } from '../src/engine/ai/review';

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
