// The phone speed test (src/ui/bench.ts): the same real decisions on every device, and its statistics.
import { describe, expect, it } from 'vitest';
import { benchDecisions, stats } from '../src/ui/bench';

describe('Extreme speed test', () => {
  it('times the same real decisions everywhere', () => {
    for (const layout of ['2p', '4p'] as const) {
      const a = benchDecisions(layout, 50);
      expect(a.length).toBe(50);
      expect(a.every((s) => s.phase === 'move' && s.moves.length > 1)).toBe(true);
      expect(JSON.stringify(benchDecisions(layout, 50))).toBe(JSON.stringify(a));
    }
  });

  it('reports p50, p99, max and the share over 1.5 s', () => {
    const ms = Array.from({ length: 100 }, (_, i) => (i + 1) * 20);
    expect(stats(ms)).toEqual({ p50: 1020, p99: 1980, max: 2000, over: 0.25 });
  });
});
