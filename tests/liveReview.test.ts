// The review while the game is played (#176, src/ui/liveReview.ts): what the live review hands the review
// queue at the game's end, finished by runReview, is Object.is-identical to the after-game review (verdicts,
// luck, chances): straight through, with an Extreme bot's thinks pausing it, after an undo onto another line,
// and for a game continued after the app was closed (the live state lost). Engines in Node (the app's wasm),
// standing in for the pool of workers; the games are cut short (a game that ends early hands off the same way).
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error: the project has no @types/node; Vitest runs on Node.
import { readFileSync } from 'node:fs';

vi.mock('../src/ui/store', async (orig) => ({ ...(await orig<typeof import('../src/ui/store')>()), saveReview: async () => {} }));

import { createGame, move, moveEvent, replay, roll, seeded, seededDie, SEATS, type GameRecord, type GameState, type Seat } from '../src/engine';
import { chooseBotMove } from '../src/engine/ai/levels';
import { luckChunk, luckPass, wasmLuck } from '../src/engine/ai/luck';
import { PLAYOUT_RULES } from '../src/engine/ai/playout-rules';
import { LUCK_CHUNK, REVIEW_VERSION, type Reviewer } from '../src/engine/ai/review';
import type { LuckPart } from '../src/engine/ai/review-worker';
import { RolloutEngine } from '../src/engine/ai/rollout';
import { LiveReview, livePoolSize, type LiveEngine } from '../src/ui/liveReview';
import { runReview, type ReviewProgress } from '../src/ui/reviewRun';

const bin = new Uint8Array(readFileSync(new URL('../src/engine/ai/extreme-net.bin', import.meta.url)));
const engine = () => RolloutEngine.create(readFileSync(new URL('../src/engine/ai/ludo_wasm.wasm', import.meta.url)), bin, PLAYOUT_RULES);

/** A Hard-bot game's record, seat 0 the person, the app's dice, cut after `states` positions. */
function game(seed: number, states: number): GameRecord {
  const seats: Seat[] = SEATS[2].map((color, owner) => ({ color, owner, bot: owner > 0, level: 'hard' }));
  const rng = seeded(seed * 31 + 7);
  let s = createGame(seats.map((x) => ({ ...x, bot: true })), 'blue');
  let events = '';
  for (let k = 1; s.phase !== 'over' && k < states; k++) {
    if (s.phase === 'roll') {
      const f = seededDie(seed, s);
      events += String(f);
      s = roll(s, () => 0, f);
    } else {
      const m = chooseBotMove(s, rng);
      events += moveEvent(m);
      s = move(s, m);
    }
  }
  return { v: 1, seats, first: 'blue', seed, events };
}

/** The record's events cut before event k (each prefix the game passed through). */
function prefixes(rec: GameRecord): string[] {
  const states = replay(rec).states;
  const out: string[] = [];
  let i = 0;
  for (let k = 0; k + 1 < states.length; k++) {
    i += states[k]!.phase === 'move' ? 2 : 1;
    out.push(rec.events.slice(0, i));
  }
  return out;
}

/** Deep equality where every number is the same double (Object.is). */
const identical = (a: unknown, b: unknown): boolean =>
  typeof a === 'number' || typeof b === 'number'
    ? Object.is(a, b)
    : Array.isArray(a) && Array.isArray(b)
      ? a.length === b.length && a.every((x, i) => identical(x, b[i]))
      : a && b && typeof a === 'object' && typeof b === 'object'
        ? Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => identical((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
        : a === b;

const [e1, e2, e3, e4] = await Promise.all([engine(), engine(), engine(), engine()]);

/** Two engines as a pool (each decision on the engine that took it), with random delays: replies out of order. */
function pool(engines: RolloutEngine[], seed: number): LiveEngine & { calls: () => number } {
  let r = seed;
  const jitter = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648) * 4;
  const busy = engines.map(() => 0);
  const bySeed = new Map<number, number>();
  let calls = 0;
  const reviewer: Reviewer = async (s, n, sd, ask) => {
    calls++;
    let k = ask?.mode === 'screen' ? undefined : bySeed.get(sd);
    if (k === undefined) {
      k = busy.indexOf(Math.min(...busy));
      if (ask?.mode !== 'screen') bySeed.set(sd, k);
    }
    busy[k]!++;
    await new Promise((res) => setTimeout(res, jitter()));
    try {
      return engines[k]!.reviewFast(s, n, sd, ask);
    } finally {
      busy[k]!--;
    }
  };
  // A chunk from a record that reaches past it, a pass of its own (as the worker's luck-begin/chunk/end).
  const luckPart = async (rec: GameRecord, c: number): Promise<LuckPart> => {
    await new Promise((res) => setTimeout(res, jitter()));
    const src = wasmLuck(engines[c % engines.length]!);
    src.begin();
    try {
      const states = replay(rec).states as GameState[];
      return luckChunk(src, rec, states, c * LUCK_CHUNK, Math.min(states.length, (c + 1) * LUCK_CHUNK));
    } finally {
      src.end();
    }
  };
  return { reviewer, parallel: engines.length, luckPart, stop: () => {}, calls: () => calls };
}

/** The luck the review queue's pool gives (ReviewPool.luck): the chunks in `have` as they are, the rest computed. */
const luckWith =
  (have: (LuckPart | undefined)[], counted: { chunks: number }) =>
  async (rec: GameRecord): Promise<{ luck: LuckPart['luck']; chances: number[][] }> => {
    const states = replay(rec).states as GameState[];
    const parts: LuckPart[] = [];
    for (let c = 0; c * LUCK_CHUNK < states.length; c++) {
      if (have[c]) parts.push(have[c]!);
      else {
        counted.chunks++;
        const src = wasmLuck(e4!);
        src.begin();
        try {
          parts.push(luckChunk(src, rec, states, c * LUCK_CHUNK, Math.min(states.length, (c + 1) * LUCK_CHUNK)));
        } finally {
          src.end();
        }
      }
    }
    return { luck: parts.flatMap((p) => p.luck), chances: parts.flatMap((p) => p.chances) };
  };

/** A whole review, to the end: its verdicts, luck and chances. */
function finish(rec: GameRecord, stored: Parameters<typeof runReview>[1], reviewer: Reviewer, luckOf: Parameters<typeof runReview>[6]): Promise<ReviewProgress> {
  return new Promise((done) => runReview(rec, stored, (p) => p.finished && done(p), false, reviewer, [0], luckOf));
}
const result = (p: ReviewProgress) => ({ moves: p.moves, luck: p.luck, chances: p.chances });

/** The after-game review: one engine, the whole luck pass at once. */
async function afterGame(rec: GameRecord) {
  const one: Reviewer = async (s, n, sd, ask) => e3!.reviewFast(s, n, sd, ask);
  const whole = async (r: GameRecord) => luckPass(wasmLuck(e4!), r, replay(r).states as GameState[]);
  return result(await finish(rec, undefined, one, whole));
}

/** The game end's hand-off, finished by the review queue's runReview: and how much was left for it. */
async function handOff(live: LiveReview, rec: GameRecord) {
  await live.idle();
  const h = live.handOff(rec);
  let calls = 0;
  const queue: Reviewer = async (s, n, sd, ask) => (calls++, e3!.reviewFast(s, n, sd, ask));
  const counted = { chunks: 0 };
  const p = await finish(rec, { v: REVIEW_VERSION, moves: h.moves, luck: null, skip: h.skip.length ? h.skip : undefined }, queue, luckWith(h.luckHave, counted));
  return { result: result(p), handed: h, calls, chunks: counted.chunks };
}

describe('the review while the game is played (#176)', () => {
  it('sizes its pool: 1 worker on a phone, 2 on a computer, none on 2 cores or fewer', () => {
    expect(livePoolSize({ hardwareConcurrency: 8, userAgentData: { mobile: true } })).toBe(1);
    expect(livePoolSize({ hardwareConcurrency: 8, userAgentData: { mobile: false } })).toBe(2);
    expect(livePoolSize({ hardwareConcurrency: 3, userAgentData: { mobile: false } })).toBe(1);
    expect(livePoolSize({ hardwareConcurrency: 2, userAgentData: { mobile: true } })).toBe(0);
    expect(livePoolSize({ hardwareConcurrency: 6 }, true)).toBe(1);
  });

  it('hands off what the after-game review would give, with Extreme thinks pausing it on the way', async () => {
    const rec = game(5, 220);
    const want = await afterGame(rec);
    const eng = pool([e1!, e2!], 7);
    const live = new LiveReview(() => eng);
    for (const [k, events] of prefixes(rec).entries()) {
      // Every few events an Extreme bot thinks: nothing new goes out meanwhile.
      if (k % 9 === 4) live.thinking(true);
      live.update({ ...rec, events });
      if (k % 9 === 6) live.thinking(false);
      if (k % 5 === 0) await live.idle();
    }
    live.thinking(false);
    const got = await handOff(live, rec);
    expect(want.moves.length).toBeGreaterThan(5);
    expect(got.handed.moves.length + got.handed.skip.length).toBeGreaterThan(5);
    expect(identical(got.result, want)).toBe(true);
    // The live review did the decisions; the queue only what came after its last update (here nothing).
    expect(got.calls).toBe(0);
    expect(got.chunks).toBeLessThanOrEqual(1);
  }, 300_000);

  it('drops what an undo took back: another line, then back to the game, gives the after-game review', async () => {
    const rec = game(6, 120);
    const want = await afterGame(rec);
    const states = replay(rec).states;
    const ps = prefixes(rec);
    // A person's decision a third of the way in, with another move to play there instead.
    const at = states.findIndex((s, i) => i > states.length / 3 && s.phase === 'move' && s.current === 0 && s.moves.length >= 2);
    // ps[at] runs through event `at`, the move made there.
    const played = ps[at]!.slice(-2);
    const other = states[at]!.moves.find((m) => moveEvent(m) !== played)!;
    const eng = pool([e1!, e2!], 11);
    const live = new LiveReview(() => eng);
    const upTo = ps[at - 1]!;
    for (const events of ps.slice(0, at)) live.update({ ...rec, events });
    // The other line: its move, then the bots and some dice, reviewed live.
    let s = move(states[at]!, other);
    let events = upTo + moveEvent(other);
    live.update({ ...rec, events });
    const rng = seeded(99);
    for (let n = 0; n < 30 && s.phase !== 'over'; n++) {
      if (s.phase === 'roll') {
        const f = 1 + Math.floor(rng() * 6);
        events += String(f);
        s = roll(s, () => 0, f);
      } else {
        const m = s.moves[Math.floor(rng() * s.moves.length)]!;
        events += moveEvent(m);
        s = move(s, m);
      }
      live.update({ ...rec, events });
    }
    await live.idle();
    // Undo: back to before the move, then the game as it was played.
    live.update({ ...rec, events: upTo });
    for (const ev of ps.slice(at)) live.update({ ...rec, events: ev });
    const got = await handOff(live, rec);
    expect(identical(got.result, want)).toBe(true);
    expect(got.calls).toBe(0);
  }, 300_000);

  it('a game continued after the app was closed: the whole record fed again gives the after-game review', async () => {
    const rec = game(8, 120);
    const want = await afterGame(rec);
    const ps = prefixes(rec);
    const half = Math.floor(ps.length / 2);
    // The first session reviews half the game, then the app is closed (its live state is lost).
    const first = new LiveReview(() => pool([e1!, e2!], 3));
    for (const events of ps.slice(0, half)) first.update({ ...rec, events });
    first.stop();
    // The continued game: the record so far at once, then the rest event by event.
    const live = new LiveReview(() => pool([e1!, e2!], 5));
    live.update({ ...rec, events: ps[half - 1]! });
    for (const events of ps.slice(half)) live.update({ ...rec, events });
    const got = await handOff(live, rec);
    expect(identical(got.result, want)).toBe(true);
    expect(got.calls).toBe(0);
  }, 300_000);
});
