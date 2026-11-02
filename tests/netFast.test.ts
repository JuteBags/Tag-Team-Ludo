// The value net's faster evaluation (#125): the sparse first layer and the memo give bit-identical values
// to the plain dense net (the code before #125, kept as tools/ai/dense-net.ts), so the luck pass, the
// win-chance bar and every review stay exactly as they were.
import { describe, expect, it } from 'vitest';
// @ts-expect-error: the project has no @types/node; Vitest runs on Node.
import { readFileSync } from 'node:fs';
import { createGame, move, replay, roll, seeded, seededDie, type GameRecord, type GameState, type Seat } from '../src/engine';
import { chooseBotMove } from '../src/engine/ai/levels';
import { Net } from '../src/engine/ai/net';
import { decodeNet } from '../src/engine/ai/netbin';
import { netChances, rollLuck } from '../src/engine/ai/review';
import { moveEvent, rollEvent } from '../src/engine/record';
import { DenseNet } from '../tools/ai/dense-net';

const bin = decodeNet(new Uint8Array(readFileSync(new URL('../src/engine/ai/extreme-net.bin', import.meta.url))));

const ALL = ['blue', 'green', 'red', 'yellow'] as const;
const LAYOUTS: Record<string, Seat[]> = {
  '2p': [{ color: 'blue', owner: 0, bot: true }, { color: 'red', owner: 1, bot: true }],
  '3p': (['blue', 'green', 'red'] as const).map((color, owner) => ({ color, owner, bot: true })),
  '4p': ALL.map((color, owner) => ({ color, owner, bot: true })),
  '2h-opposite': ALL.map((color) => ({ color, owner: color === 'blue' || color === 'red' ? 0 : 1, bot: true })),
  '2h-side': ALL.map((color) => ({ color, owner: color === 'blue' || color === 'green' ? 0 : 1, bot: true })),
};

/** A Hard-bot game with the app's dice, as a record (the luck pass's input). */
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

describe('the value net, sparse and remembered (#125)', () => {
  const ref = new DenseNet(bin);

  it('has no -0 bias in the first trunk layer (the one case the sparse sum handles densely)', () => {
    expect(Array.from(bin.trunk[0]!.b).some((x) => Object.is(x, -0))).toBe(false);
  });

  it('gives every chance bit for bit as the dense net, memo off and on, in every layout', () => {
    const plain = new Net(bin);
    const kept = new Net(bin);
    kept.remember();
    let checked = 0;
    for (const [layout, singles] of [['2p', false], ['3p', false], ['4p', false], ['2h-opposite', false], ['2h-side', true], ['4p', true]] as const) {
      const rec = game(layout, 11, singles);
      const states = replay(rec).states as GameState[];
      // Each state twice through the memo: the second read is a lookup and must be the same doubles.
      for (const s of [...states, ...states]) {
        if (s.phase === 'over') continue;
        const r = ref.ownerChances(s);
        if (!same(plain.ownerChances(s), r) || !same(kept.ownerChances(s), r)) expect.fail(`${layout}: position ${states.indexOf(s)} differs`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(2000);
  }, 120_000);

  it('gives the luck pass bit for bit as before: every luck, sd and win chance', () => {
    const kept = new Net(bin);
    kept.remember();
    // The dense reference is the slow part (a whole 4p game's luck is about 12 s), so beyond the 2p game the
    // luck pass is checked on each game's opening states.
    for (const [layout, seed, upTo] of [['2p', 101, Infinity], ['3p', 5, 200], ['2h-opposite', 7, 200], ['4p', 102, 120]] as const) {
      const rec = game(layout, seed);
      const states = (replay(rec).states as GameState[]).slice(0, upTo);
      kept.forget();
      const a = rollLuck(rec, states, ref);
      const b = rollLuck(rec, states, kept);
      expect(b.length).toBe(a.length);
      a.forEach((x, i) => {
        const y = b[i]!;
        if (x.at !== y.at || x.face !== y.face || !Object.is(x.luck, y.luck) || !Object.is(x.sd, y.sd)) expect.fail(`${layout} roll ${i}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
      });
      expect(JSON.stringify(netChances(rec, states, kept))).toBe(JSON.stringify(netChances(rec, states, ref)));
    }
  }, 300_000);
});
