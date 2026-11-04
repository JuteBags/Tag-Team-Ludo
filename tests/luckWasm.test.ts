// The review's luck pass in WebAssembly (#125 step B): the module gives the very doubles the net in JS
// gives (the face values and everyone's chances, Object.is), so every luck number, sd and win-chance bar is
// unchanged; chunked calls give what one call gives; and ending a pass frees the module's cache.
import { describe, expect, it } from 'vitest';
// @ts-expect-error: the project has no @types/node; Vitest runs on Node.
import { readFileSync } from 'node:fs';
import { createGame, move, replay, roll, seeded, seededDie, type GameRecord, type GameState, type Seat } from '../src/engine';
import { chooseBotMove } from '../src/engine/ai/levels';
import { luckPass, netLuck, wasmLuck } from '../src/engine/ai/luck';
import { Net } from '../src/engine/ai/net';
import { decodeNet } from '../src/engine/ai/netbin';
import { PLAYOUT_RULES } from '../src/engine/ai/playout-rules';
import { faceValues, isJudgedRoll, netChances, peopleIn, rollLuck } from '../src/engine/ai/review';
import { RolloutEngine } from '../src/engine/ai/rollout';
import { ownerValues } from '../src/engine/ai/search';
import { moveEvent, rollEvent } from '../src/engine/record';

const binBytes = new Uint8Array(readFileSync(new URL('../src/engine/ai/extreme-net.bin', import.meta.url)));
const engine = () => RolloutEngine.create(readFileSync(new URL('../src/engine/ai/ludo_wasm.wasm', import.meta.url)), binBytes, PLAYOUT_RULES);
/** The net in JS (#127's Net, bit-identical to the dense net: tests/netFast.test.ts), the reference here. */
const jsNet = () => {
  const n = new Net(decodeNet(binBytes));
  n.remember();
  return n;
};

const ALL = ['blue', 'green', 'red', 'yellow'] as const;
const LAYOUTS: Record<string, Seat[]> = {
  '2p': [{ color: 'blue', owner: 0, bot: true }, { color: 'red', owner: 1, bot: true }],
  '3p': (['blue', 'green', 'red'] as const).map((color, owner) => ({ color, owner, bot: true })),
  '4p': ALL.map((color, owner) => ({ color, owner, bot: true })),
  '2h-opposite': ALL.map((color) => ({ color, owner: color === 'blue' || color === 'red' ? 0 : 1, bot: true })),
  '2h-side': ALL.map((color) => ({ color, owner: color === 'blue' || color === 'green' ? 0 : 1, bot: true })),
};

/** review_speed.ts's kind of game: every seat Hard, the app's dice. */
function game(layout: string, seed: number, singles = false): GameRecord {
  const seats = LAYOUTS[layout]!.map((s) => ({ ...s, level: 'hard' as const }));
  const rng = seeded(seed * 31 + 7);
  let s = createGame(seats, seats[seed % seats.length]!.color, singles);
  let events = '';
  for (let k = 0; s.phase !== 'over' && k < 20000; k++) {
    if (s.phase === 'roll') {
      const f = seededDie(seed, s);
      events += rollEvent(f);
      s = roll(s, () => 0, f);
    } else {
      const m = chooseBotMove(s, rng);
      events += moveEvent(m);
      s = move(s, m);
    }
  }
  return { v: 1, seats, first: seats[seed % seats.length]!.color, singles: singles || undefined, seed, events };
}

const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => Object.is(x, b[i]));

// The bench page's review games (2p 101 whole, 4p 102's first 400 states), and other layouts, doubles on and off.
const GAMES: [string, number, boolean, number][] = [
  ['2p', 101, false, Infinity],
  ['4p', 102, false, 400],
  ['3p', 5, false, 300],
  ['2h-opposite', 7, false, 300],
  ['2h-side', 9, true, 300],
  ['4p', 13, true, 300],
  ['2p', 21, true, Infinity],
];

describe('the luck pass in WebAssembly (#125)', () => {
  it('is in the committed module', async () => {
    expect((await engine()).hasLuck).toBe(true);
  });

  it('gives every face value and every chance bit for bit as the net in JS, in every layout', async () => {
    const e = await engine();
    const net = jsNet();
    let faces = 0;
    for (const [layout, seed, singles, upTo] of GAMES) {
      const rec = game(layout, seed, singles);
      const states = (replay(rec).states as GameState[]).slice(0, upTo);
      const people = peopleIn(rec);
      net.forget();
      e.luckBegin();
      try {
        const rolls = states.filter((_, i) => isJudgedRoll(states, i));
        const w = e.luckChunk(rolls, 0);
        rolls.forEach((s, k) => {
          const js = faceValues(net, s);
          if (!same(w.subarray(6 * k, 6 * k + 6), js)) expect.fail(`${layout} ${seed}: roll ${k} faces ${Array.from(w.subarray(6 * k, 6 * k + 6))} vs ${js}`);
          faces += 6;
        });
        const o = e.luckChunk(states, 1);
        states.forEach((s, k) => {
          const js = ownerValues(net, s, people);
          if (!same(o.subarray(4 * k, 4 * k + people), js)) expect.fail(`${layout} ${seed}: state ${k} chances ${Array.from(o.subarray(4 * k, 4 * k + people))} vs ${Array.from(js)}`);
        });
      } finally {
        e.luckEnd();
      }
    }
    expect(faces).toBeGreaterThan(5000);
  }, 300_000);

  it('gives the luck pass exactly as review.ts rollLuck and netChances, chunked or in one call', async () => {
    const e = await engine();
    const net = jsNet();
    for (const [layout, seed, singles, upTo] of GAMES.slice(0, 3)) {
      const rec = game(layout, seed, singles);
      const states = (replay(rec).states as GameState[]).slice(0, upTo);
      net.forget();
      const ref = { luck: rollLuck(rec, states, net), chances: netChances(rec, states, net) };
      const chunked = luckPass(wasmLuck(e), rec, states);
      const whole = luckPass(wasmLuck(e), rec, states, states.length);
      const tsChunked = luckPass(netLuck(net), rec, states);
      for (const got of [chunked, whole, tsChunked]) {
        expect(got.luck.length).toBe(ref.luck.length);
        got.luck.forEach((l, i) => {
          const r = ref.luck[i]!;
          if (l.at !== r.at || l.face !== r.face || l.owner !== r.owner || !Object.is(l.luck, r.luck) || !Object.is(l.sd, r.sd)) expect.fail(`${layout} ${seed} roll ${i}: ${JSON.stringify(l)} vs ${JSON.stringify(r)}`);
        });
        expect(JSON.stringify(got.chances)).toBe(JSON.stringify(ref.chances));
      }
    }
  }, 300_000);

  it('frees its cache when a pass ends, also one stopped between chunks, and keeps it within its cap', async () => {
    const e = await engine();
    const rec = game('4p', 102);
    const states = replay(rec).states as GameState[];
    const rolls = states.filter((_, i) => isJudgedRoll(states, i));
    e.luckBegin();
    e.luckChunk(rolls.slice(0, 32), 0);
    expect(e.luckMemory.size).toBeGreaterThan(0);
    // Stopped here: the worker ends the pass.
    e.luckEnd();
    expect(e.luckMemory.size).toBe(0);
    expect(() => e.luckChunk(rolls.slice(0, 1), 0)).toThrow(/not started/);
    // A whole 4p game: emptied before each roll's faces, the cache stays near its cap (2,048 positions; one
    // roll's searches can pass it before the next check).
    luckPass(wasmLuck(e), rec, states);
    expect(e.luckMemory.size).toBe(0);
    expect(e.luckMemory.peak).toBeGreaterThan(10);
    expect(e.luckMemory.peak).toBeLessThan(2048 + 1024);
  }, 300_000);
});
