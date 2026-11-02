// Extreme's rollout worker lives only while it's needed (#98): stopRolloutWorker() ends it (the game screen
// calls it when it goes away, when the game ends and when the app is hidden), a move in flight then fails
// with RolloutStopped and its late answer is dropped, and the next Extreme move starts a new worker.
import { describe, expect, it, vi } from 'vitest';
import { createGame, move, roll, seeded, type GameState, type Seat } from '../src/engine';

/** A fake worker we answer by hand: it remembers every request and whether it was terminated. */
class FakeWorker {
  static made: FakeWorker[] = [];
  onmessage: ((e: { data: { id: number; index: number } }) => void) | null = null;
  onerror: (() => void) | null = null;
  asked: number[] = [];
  terminated = false;
  constructor() {
    FakeWorker.made.push(this);
  }
  postMessage(m: { id: number }) {
    this.asked.push(m.id);
  }
  terminate() {
    this.terminated = true;
  }
  /** Answers request `id` with move `index`, as a worker's message would arrive. */
  answer(id: number, index: number) {
    this.onmessage?.({ data: { id, index } });
  }
}
vi.stubGlobal('Worker', FakeWorker);
const { chooseBotMoveAsync, RolloutStopped, stopRolloutWorker } = await import('../src/engine/ai/levels');

const SEATS: Seat[] = [
  { color: 'blue', owner: 0, bot: true, level: 'extreme' },
  { color: 'green', owner: 1, bot: true, level: 'extreme' },
];

/** An Extreme decision with a real choice (more than one move). */
function choice(): GameState {
  const rng = seeded(3);
  let s = createGame(SEATS, 'blue');
  for (let i = 0; i < 2000; i++) {
    if (s.phase === 'roll') s = roll(s, rng);
    else if (s.moves.length > 2) return s;
    else s = move(s, s.moves[0]!);
  }
  throw new Error('no choice found');
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Extreme's rollout worker", () => {
  it('is started on first use, ended by stopRolloutWorker, and started again by the next move', async () => {
    const s = choice();
    const first = chooseBotMoveAsync(s, seeded(1));
    await flush();
    expect(FakeWorker.made.length).toBe(1);
    const w = FakeWorker.made[0]!;
    w.answer(w.asked[0]!, 1);
    expect(await first).toEqual(s.moves[1]);
    // The game ends (or goes away): the worker goes.
    stopRolloutWorker();
    expect(w.terminated).toBe(true);
    stopRolloutWorker(); // nothing running: a no-op
    // The next Extreme game's move starts a new one.
    const next = chooseBotMoveAsync(s, seeded(2));
    await flush();
    expect(FakeWorker.made.length).toBe(2);
    const w2 = FakeWorker.made[1]!;
    w2.answer(w2.asked[0]!, 2);
    expect(await next).toEqual(s.moves[2]);
    stopRolloutWorker();
  });

  it('fails a move in flight with RolloutStopped and drops its late answer, so it never reaches a new game', async () => {
    const s = choice();
    const inFlight = chooseBotMoveAsync(s, seeded(4));
    await flush();
    const old = FakeWorker.made.at(-1)!;
    const oldId = old.asked[0]!;
    stopRolloutWorker();
    await expect(inFlight).rejects.toBeInstanceOf(RolloutStopped);
    // A new game asks for a move on a new worker.
    const fresh = chooseBotMoveAsync(s, seeded(5));
    await flush();
    const w = FakeWorker.made.at(-1)!;
    expect(w).not.toBe(old);
    // The old worker's late answer arrives first: it must not resolve the new request.
    old.answer(oldId, 0);
    w.answer(oldId, 0); // even with the old id on the new worker: that id is no longer pending
    await flush();
    let settled = false;
    void fresh.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    w.answer(w.asked[0]!, 2);
    expect(await fresh).toEqual(s.moves[2]);
    stopRolloutWorker();
  });
});
