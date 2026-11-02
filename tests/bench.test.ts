// The phone speed test (src/ui/bench.ts): the same real decisions on every device, and its statistics.
import { describe, expect, it } from 'vitest';
import { benchDecisions, benchOrder, stats } from '../src/ui/bench';

describe('Extreme speed test', () => {
  it('times the same real decisions everywhere', () => {
    for (const layout of ['2p', '4p'] as const) {
      const a = benchDecisions(layout, 50);
      expect(a.length).toBe(50);
      expect(a.every((s) => s.phase === 'move' && s.moves.length > 1)).toBe(true);
      expect(JSON.stringify(benchDecisions(layout, 50))).toBe(JSON.stringify(a));
    }
  });

  it('reports p50, p90, max and the share over 1.5 s', () => {
    const ms = Array.from({ length: 100 }, (_, i) => (i + 1) * 20);
    expect(stats(ms)).toEqual({ p50: 1020, p90: 1800, max: 2000, over: 0.25 });
  });

  it('interleaves the arms so heating up weighs on all of them alike', () => {
    const order = benchOrder(50);
    expect(order.length).toBe(200);
    for (const layout of ['2p', '4p']) for (const nmax of [128, 256]) expect(order.filter((r) => r.layout === layout && r.nmax === nmax).length).toBe(50);
    // 128 and 256 go first equally often, and each arm's runs are spread evenly through the test.
    const firsts = order.filter((_, k) => k % 2 === 0);
    expect(firsts.filter((r) => r.nmax === 128).length).toBe(50);
    const meanPos = (nmax: number) => order.map((r, k) => (r.nmax === nmax ? k : 0)).reduce((a, b) => a + b, 0) / 100;
    expect(Math.abs(meanPos(128) - meanPos(256))).toBeLessThan(1);
  });
});
