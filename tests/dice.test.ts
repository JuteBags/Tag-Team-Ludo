import { describe, expect, it } from 'vitest';
import { analyzeDice, diceWeights, rollDice, sampleFace, seeded, type Color } from '../src/engine';
import { B, mk, prog } from './helpers';

const rng = seeded(7);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe('dice weights', () => {
  it('is fair when nothing is at stake', () => {
    for (const w of diceWeights(mk({ blue: B, red: B }), 'blue', rng)) expect(w).toBeCloseTo(1 / 6, 10);
  });

  it('boosts a killing face to 4/18', () => {
    const w = diceWeights(mk({ blue: [5, -1, -1, -1], red: [prog('red', 46), -1, -1, -1] }), 'blue', rng);
    expect(w[1]).toBeCloseTo(4 / 18, 10);
    for (const i of [0, 2, 3, 4, 5]) expect(w[i]).toBeCloseTo(14 / 90, 10);
  });

  it('boosts an escape to a star', () => {
    const { weights, why } = analyzeDice(mk({ blue: [5, -1, -1, -1], red: [prog('red', 41), -1, -1, -1] }), 'blue', rng);
    expect(why.escape).toEqual([3]);
    expect(weights[2]).toBeCloseTo(4 / 18, 10);
  });

  it('lowers the exact-finish face to 2/18', () => {
    const w = diceWeights(mk({ blue: [52, -1, -1, -1], red: B }), 'blue', rng);
    expect(w[3]).toBeCloseTo(2 / 18, 10);
    for (const i of [0, 1, 2, 4, 5]) expect(w[i]).toBeCloseTo(16 / 90, 10);
  });

  it('cancels out when one face both kills and finishes', () => {
    const w = diceWeights(mk({ blue: [5, 52, -1, -1], red: [prog('red', 48), -1, -1, -1] }), 'blue', rng);
    for (const x of w) expect(x).toBeCloseTo(1 / 6, 10);
  });

  it('boosts at most two faces', () => {
    const ps = mk({ blue: [5, -1, -1, -1], red: [prog('red', 45), prog('red', 46), prog('red', 48), -1] });
    const { weights, why } = analyzeDice(ps, 'blue', rng);
    expect(why.kill).toEqual([1, 2, 4]);
    expect(weights.filter((w) => Math.abs(w - 4 / 18) < 1e-9)).toHaveLength(2);
    expect(sum(weights)).toBeCloseTo(1, 12);
  });

  it('always sums to 1 and stays within 2/18..5/18', () => {
    const r = seeded(99);
    const colors: Color[] = ['blue', 'green', 'red', 'yellow'];
    for (let n = 0; n < 3000; n++) {
      const tok = () => [0, 1, 2, 3].map(() => (r() < 0.25 ? -1 : Math.floor(r() * 57)));
      const ps = mk({ blue: tok(), green: tok(), red: tok(), yellow: tok() });
      const w = diceWeights(ps, colors[n % 4]!, r);
      expect(sum(w)).toBeCloseTo(1, 9);
      for (const x of w) {
        expect(x).toBeGreaterThanOrEqual(2 / 18 - 1e-9);
        expect(x).toBeLessThanOrEqual(5 / 18 + 1e-9);
      }
    }
  });
});

describe('dice sampling (Monte Carlo)', () => {
  it('matches the weights within ±0.5% over 600k rolls', () => {
    const ps = mk({ blue: [5, 52, -1, -1], red: [prog('red', 46), -1, -1, -1] });
    const w = diceWeights(ps, 'blue', rng);
    const r = seeded(2024);
    const counts = [0, 0, 0, 0, 0, 0];
    const N = 600_000;
    for (let i = 0; i < N; i++) counts[sampleFace(w, r) - 1]!++;
    counts.forEach((c, i) => expect(Math.abs(c / N - w[i]!)).toBeLessThan(0.005));
  });

  it('rollDice follows the same weights end to end', () => {
    const ps = mk({ blue: [5, -1, -1, -1], red: [prog('red', 46), -1, -1, -1] });
    const r = seeded(5);
    const N = 40_000;
    let twos = 0;
    for (let i = 0; i < N; i++) if (rollDice(ps, 'blue', r) === 2) twos++;
    expect(Math.abs(twos / N - 4 / 18)).toBeLessThan(0.01);
  });
});
