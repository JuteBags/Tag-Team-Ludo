// The phone speed tests (src/ui/bench.ts): the same real decisions and games on every device, and the statistics.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGame, move, replay, roll, SEATS, seeded, seededDie } from '../src/engine';
import { chooseBotMove } from '../src/engine/ai/levels';
import { benchDecisions, benchOrder, benchRun, REVIEW_GAMES, reviewRecord, stats } from '../src/ui/bench';

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

  it("reviews review-speed.yml's games: the very games review_speed.ts plays, and they replay to the end", () => {
    for (const g of REVIEW_GAMES) {
      const rec = reviewRecord(g);
      // review_speed.ts's game, played again: tools/ai/common.ts MODES seats (SEATS[n], seat i owned by i, all
      // bots), seat 0 at the mover's level (Hard) and everyone else Hard, the app's dice.
      const n = g.layout === '2p' ? 2 : 4;
      const seats = SEATS[n].map((color, owner) => ({ color, owner, bot: true, level: 'hard' as const }));
      const rng = seeded(g.seed * 31 + 7);
      let s = createGame(seats, seats[g.seed % n]!.color, false);
      let events = '';
      for (let k = 0; s.phase !== 'over' && k < 20000; k++) {
        if (s.phase === 'roll') {
          const f = seededDie(g.seed, s);
          events += String(f);
          s = roll(s, () => 0, f);
        } else {
          const m = chooseBotMove(s, rng);
          events += (m.tokens.length === 1 ? 'abcd'[m.tokens[0]!]! : 'efghij'[['01', '02', '03', '12', '13', '23'].indexOf([...m.tokens].sort().join(''))]!) + m.roll;
          s = move(s, m);
        }
      }
      expect(JSON.stringify(rec)).toBe(JSON.stringify({ v: 1, seats, first: seats[g.seed % n]!.color, seed: g.seed, events }));
      const r = replay(rec);
      expect(r.ok).toBe(true);
      expect(r.states.at(-1)!.phase).toBe('over');
    }
  }, 60_000);

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

  describe('a run, and leaving the bench mid-run (#126 review)', () => {
    afterEach(() => vi.unstubAllGlobals());
    /** A run of a stand-in test that ends only when stopped (or `finish` is called); the queue's pause calls. */
    const start = () => {
      vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn(), visibilityState: 'visible' });
      const paused: boolean[] = [];
      const terminate = vi.fn();
      const said: string[] = [];
      let finish = () => {};
      const run = benchRun(true, {
        worker: () => ({ terminate }) as unknown as Worker,
        pause: (on) => paused.push(on),
        say: (l) => said.push(l),
        test: (_w, _say, _hidden, onStop) =>
          new Promise<void>((done) => {
            finish = done;
            onStop(done);
          }),
      });
      return { run, paused, terminate, said, finish: () => finish() };
    };

    it('pauses the review queue while it runs and unpauses it once at the end', async () => {
      const r = start();
      expect(r.paused).toEqual([true]);
      await new Promise((t) => setTimeout(t, 0));
      r.finish();
      await r.run.done;
      expect(r.paused).toEqual([true, false]);
      expect(r.terminate).toHaveBeenCalledOnce();
      expect(r.said.at(-1)).toBe('done');
    });

    it('leaving mid-run stops it at once, and the run never touches the queue again', async () => {
      const r = start();
      await Promise.resolve();
      r.run.stop();
      // Stopped now: the worker ends and the queue is unpaused at that moment.
      expect(r.terminate).toHaveBeenCalledOnce();
      expect(r.paused).toEqual([true, false]);
      // The app then starts an Extreme game, which pauses the queue itself; the stopped run ending later must
      // leave that as it is: no second unpause, no more lines.
      r.paused.push(true);
      await r.run.done;
      r.finish();
      await new Promise((t) => setTimeout(t, 10));
      expect(r.paused).toEqual([true, false, true]);
      expect(r.terminate).toHaveBeenCalledOnce();
      expect(r.said).toEqual([]);
    });

    it('leaving before the test has even started (waiting for the wake lock) stops it too', async () => {
      let grant = (_: { release(): Promise<void> }) => {};
      vi.stubGlobal('navigator', { wakeLock: { request: () => new Promise((g) => (grant = g)) } });
      const r = start();
      r.run.stop();
      expect(r.paused).toEqual([true, false]);
      const release = vi.fn(async () => {});
      grant({ release });
      await r.run.done;
      expect(release).toHaveBeenCalledOnce();
      expect(r.paused).toEqual([true, false]);
      expect(r.said).toEqual([]);
    });
  });
});
