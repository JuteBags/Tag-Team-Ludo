// A run of three 6s in the luck (#135): the third 6 cancels the run (RULES.md rule 13), so 6, 6, 6 nets
// unlucky; a 6 that rolls again is valued one step on (the net reads a tray with 6s up to 5 points low); and
// the review shows a cancelled run as one event worth the run's total.
import { describe, expect, it } from 'vitest';
// @ts-expect-error: the project has no @types/node; Vitest runs on Node.
import { readFileSync } from 'node:fs';
import { createGame, move, replay, roll, seeded, seededDie, type GameRecord, type GameState, type Seat } from '../src/engine';
import { chooseBotMove } from '../src/engine/ai/levels';
import { Net } from '../src/engine/ai/net';
import { decodeNet } from '../src/engine/ai/netbin';
import { faceValues, rollLuck } from '../src/engine/ai/review';
import { ownerValues } from '../src/engine/ai/search';
import { moveEvent, rollEvent } from '../src/engine/record';
import { framesOf } from '../src/ui/replay';
import { bigRolls, rollEvents, rollText, sixRuns } from '../src/ui/reviewText';

const net = new Net(decodeNet(new Uint8Array(readFileSync(new URL('../src/engine/ai/extreme-net.bin', import.meta.url)))));
const TWO: Seat[] = [{ color: 'blue', owner: 0, bot: true }, { color: 'red', owner: 1, bot: true }];

/** The luck of each roll of 6 -> 6 -> 6 from `s0`, fair faces (a crafted position has no game seed). */
function sixRun(s0: GameState): number[] {
  const out: number[] = [];
  let s = s0;
  for (let k = 0; k < 3; k++) {
    const v = faceValues(net, s);
    out.push(100 * (v[5]! - v.reduce((t, x) => t + x / 6, 0)));
    s = roll(s, () => 0, 6);
  }
  return out;
}

describe('a run of three 6s (#135)', () => {
  it('nets unlucky from a quiet mid-game start, and the third 6 alone clearly so', () => {
    const g = createGame(TWO, 'blue');
    const tokens: Record<string, number[]> = { blue: [10, 22, -1, 30], red: [5, 15, 28, -1] };
    const s0: GameState = { ...g, players: g.players.map((p) => ({ ...p, tokens: tokens[p.color]! })) };
    const [first, second, third] = sixRun(s0);
    expect(first).toBeGreaterThan(0);
    expect(third).toBeLessThan(-5);
    expect(first! + second! + third!).toBeLessThan(-2);
  });

  it('values a 6 that rolls again one step on: the expectation over the next face, a second 6 at the net', () => {
    const s0 = createGame(TWO, 'blue');
    const after6 = roll(s0, () => 0, 6);
    const next = faceValues(net, after6);
    // One step: the next face's values, except a second 6, which takes the net's value of that position.
    const twoSixes = ownerValues(net, roll(after6, () => 0, 6), 2)[0]!;
    const e = [...next.slice(0, 5), twoSixes].reduce((t, x) => t + x / 6, 0);
    expect(faceValues(net, s0)[5]).toBe(e);
  });

  it("marks a game's cancelled runs: the third 6 carries the run's total, the first two are part of it", () => {
    // A Hard-bot game with the app's dice that has a run of three 6s.
    let rec: GameRecord | null = null;
    for (let seed = 1; !rec && seed < 400; seed++) {
      const seats = TWO.map((s) => ({ ...s, level: 'hard' as const }));
      const rng = seeded(seed);
      let s = createGame(seats, 'blue');
      let events = '';
      let three = false;
      for (let k = 0; s.phase !== 'over' && k < 20000; k++) {
        if (s.phase === 'roll') {
          const f = seededDie(seed, s);
          events += rollEvent(f);
          s = roll(s, () => 0, f);
          three ||= s.event?.type === 'three-sixes';
        } else {
          const m = chooseBotMove(s, rng);
          events += moveEvent(m);
          s = move(s, m);
        }
      }
      if (three) rec = { v: 1, seats, first: 'blue', seed, events };
    }
    expect(rec).not.toBeNull();
    const states = replay(rec!).states as GameState[];
    const luck = rollLuck(rec!, states, net);
    const runs = luck.filter((l) => l.run !== undefined);
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) {
      const k = luck.indexOf(r);
      const [a, b] = [luck[k - 2]!, luck[k - 1]!];
      expect([a.face, b.face, r.face]).toEqual([6, 6, 6]);
      expect(a.inRun && b.inRun).toBe(true);
      expect(r.run).toBe(a.luck + b.luck + r.luck);
      expect(states[r.at + 1]!.event?.type).toBe('three-sixes');
    }
    // Only runs are marked; every luck number is as it was.
    expect(luck.filter((l) => l.inRun).length).toBe(2 * runs.length);
    // The replay's caption for the cancelling roll says what was rolled, not "the turn is lost": dice kept from
    // before the run still play (rule 13).
    const caps = framesOf(rec!).frames.filter((f) => f.dice?.length === 3 && f.dice.every((d) => d === 6) && states[f.at]!.event?.type === 'three-sixes').map((f) => f.caption);
    expect(caps.length).toBeGreaterThan(0);
    for (const c of caps) expect(c).toMatch(/^.+ rolled 6, 6, 6$/);
  }, 120_000);

  it('shows a cancelled run as one event worth its total', () => {
    const luck = [
      { at: 1, owner: 0, face: 6, luck: 4, sd: 5, inRun: true as const },
      { at: 3, owner: 0, face: 6, luck: 1, sd: 5, inRun: true as const },
      { at: 5, owner: 0, face: 6, luck: -11, sd: 6, run: -6 },
      { at: 7, owner: 1, face: 2, luck: 3, sd: 4 },
    ];
    expect(rollEvents(luck).map((r) => [r.at, r.luck])).toEqual([[5, -6], [7, 3]]);
    expect(bigRolls(luck)[0]!.at).toBe(5);
    expect(rollText(luck[2]!, 'Aarav', true)).toBe('Three 6s cancelled: −6% to win');
    expect(rollText(luck[2]!, 'Aarav', false)).toBe("Aarav's three 6s cancelled: −6% to win for them");
    // Listed for its person whether or not it's a big roll.
    expect(sixRuns(luck, 0).map((r) => [r.at, r.luck])).toEqual([[5, -6]]);
    expect(sixRuns(luck, 1)).toEqual([]);
  });
});
