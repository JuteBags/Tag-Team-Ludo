// "One of yours" (#99, src/engine/ai/ownPuzzles.ts): a key verdict from a full review becomes a puzzle when
// its position has one clear best, by the pool's rule with a margin for the stand-in standard error:
// 2nd-best gap − 2·se ≥ 3·f + 0.5 and se ≤ 1.5; never from a race or net verdict, an older review, or a tie.
import { describe, expect, it } from 'vitest';
import { createGame, move, moveEvent, positionKey, replay, roll, seeded, seededDie, SEATS, type GameRecord, type GameState, type Seat } from '../src/engine';
import { chooseBotMove } from '../src/engine/ai/levels';
import { OWN_MARGIN, OWN_MAX_SE, ownPuzzles, ownRollStrip, type ReviewedGame } from '../src/engine/ai/ownPuzzles';
import { REVIEW_VERSION, type MoveReview } from '../src/engine/ai/review';

/** A 2p Hard-bot game, seat 0 the person, the app's dice. */
function game(seed: number): GameRecord {
  const seats: Seat[] = SEATS[2].map((color, owner) => ({ color, owner, bot: owner > 0, level: 'hard' }));
  const rng = seeded(seed * 31 + 7);
  let s = createGame(seats.map((x) => ({ ...x, bot: true })), 'blue');
  let events = '';
  for (let k = 0; s.phase !== 'over' && k < 20000; k++) {
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

const rec = game(4);
const states = (replay(rec) as { states: GameState[] }).states;
/** Seat 0's decisions where every move reaches a different position (so no move shares the best's). */
const distinct = states
  .map((s, at) => ({ s, at }))
  .filter(({ s }) => s.phase === 'move' && s.current === 0 && s.moves.length >= 3 && new Set(s.moves.map((m) => positionKey(move(s, m)))).size === s.moves.length);

/** A verdict at decision `at`: the best is move 0, the played move the last, the others `gap2` below. */
function verdict(at: number, gap2: number, o: Partial<MoveReview> = {}): MoveReview {
  const n = states[at]!.moves.length;
  const played = n - 1;
  const gaps = Array.from({ length: n }, (_, i) => (i === 0 ? 0 : i === played ? 20 : gap2));
  return { at, owner: 0, played, best: 0, playedChance: 0.3, bestChance: 0.5, gap: 20, se: 1, label: 'blunder', gaps, ...o };
}
const one = (moves: MoveReview[], v = REVIEW_VERSION): ReviewedGame[] => [{ id: 'g1', rec, v, moves }];

describe('own puzzles (#99)', () => {
  it('has decisions to test with', () => expect(distinct.length).toBeGreaterThanOrEqual(2));

  it('takes a key verdict whose 2nd best is clear by 2 se plus the margin, and not one just under', () => {
    const at = distinct[0]!.at;
    const edge = 3 + OWN_MARGIN + 2 * 1; // 2p: f = 1, se 1
    expect(ownPuzzles(one([verdict(at, edge)]))).toHaveLength(1);
    expect(ownPuzzles(one([verdict(at, edge - 0.1)]))).toHaveLength(0);
  });

  it('never from a loose se, a race or net verdict, a lighter label, an older review, or a tie', () => {
    const at = distinct[0]!.at;
    expect(ownPuzzles(one([verdict(at, 12, { se: OWN_MAX_SE + 0.1 })]))).toHaveLength(0);
    expect(ownPuzzles(one([verdict(at, 12, { approx: 'race' })]))).toHaveLength(0);
    expect(ownPuzzles(one([verdict(at, 12, { label: 'inaccuracy' })]))).toHaveLength(0);
    expect(ownPuzzles(one([verdict(at, 12)], REVIEW_VERSION - 1))).toHaveLength(0);
    // Another move at 0 that reaches a different position: two bests, not a puzzle.
    const tie = verdict(at, 12);
    tie.gaps = tie.gaps!.map((g, i) => (i === 1 ? 0 : g));
    expect(ownPuzzles(one([tie]))).toHaveLength(0);
  });

  it('carries the position, the gaps, the chances, a band, and the real game from the move played', () => {
    const at = distinct[0]!.at;
    const [p] = ownPuzzles(one([verdict(at, 12)]));
    expect(p!.id).toBe(`g1:${at}`);
    expect(positionKey(p!.state)).toBe(positionKey(states[at]!));
    expect(p!.best).toBe(0);
    expect(p!.chances[0]).toBe(50);
    expect(p!.chances[p!.played.move]).toBe(30);
    expect(p!.chances[1]).toBe(38);
    expect(['easy', 'medium', 'hard']).toContain(p!.band);
    expect(p!.played.events.slice(0, 2)).toBe(moveEvent(states[at]!.moves[p!.played.move]!));
    expect(rec.events).toContain(p!.played.events);
  });

  it('puts the biggest mistakes first, then newer games', () => {
    const [a, b] = distinct;
    const small = verdict(a!.at, 12, { gap: 8 });
    small.gaps = small.gaps!.map((g, i) => (i === small.played ? 8 : g));
    const big = verdict(b!.at, 12);
    const out = ownPuzzles([{ id: 'new', rec, v: REVIEW_VERSION, moves: [small] }, { id: 'old', rec, v: REVIEW_VERSION, moves: [big] }]);
    expect(out.map((p) => p.id)).toEqual([`old:${b!.at}`, `new:${a!.at}`]);
  });

  it("works out the roll's strip when it opens (#194): the roll before it, the rolled face as the verdict's best", async () => {
    // A decision straight after a roll.
    const at = distinct.find(({ at }) => states[at - 1]?.phase === 'roll' && states[at - 1]!.current === states[at]!.current)!.at;
    const [p] = ownPuzzles(one([verdict(at, 12)]));
    expect(p!.rollFrom).not.toBe(null);
    expect(positionKey(roll(p!.rollFrom!.pre, () => 0, p!.state.dice!))).toBe(positionKey(states[at]!));
    // The faces: a stand-in for the worker (faceValues.ts runs there), each face its own value.
    let asked: { face: number; chance: number } | undefined;
    const strip = (await ownRollStrip(p!, (_pre, _n, _seed, rolled) => ((asked = rolled), Promise.resolve([0.3, 0.35, 0.4, 0.45, 0.5, 0.55]))))!;
    expect(asked).toEqual({ face: p!.state.dice!, chance: p!.chances[p!.best]! / 100 });
    expect(strip.face).toBe(p!.state.dice);
    expect(strip.faces).toEqual([30, 35, 40, 45, 50, 55]);
    // Before the roll: the faces weighted by the game's dice; the roll's effect is the rolled face's lead over it.
    const w = strip.weights;
    const sum = w.reduce((a, x) => a + x, 0);
    expect(strip.before).toBeCloseTo(strip.faces.reduce((a, v, k) => a + (v * w[k]!) / sum, 0), 9);
    expect(strip.effect).toBeCloseTo(strip.faces[strip.face - 1]! - strip.before, 9);
    expect(sum).toBeCloseTo(100, 0);
  });

  it('has no strip for a decision in the middle of a turn (no roll right before it)', async () => {
    const mid = states.findIndex((s, i) => i > 0 && s.phase === 'move' && s.current === 0 && s.moves.length >= 2 && states[i - 1]!.phase === 'move');
    if (mid < 0) return;
    const n = states[mid]!.moves.length;
    const v: MoveReview = { at: mid, owner: 0, played: n - 1, best: 0, playedChance: 0.3, bestChance: 0.5, gap: 20, se: 1, label: 'blunder', gaps: states[mid]!.moves.map((_, i) => (i ? 20 : 0)) };
    const out = ownPuzzles(one([v]));
    for (const p of out) expect(p.rollFrom).toBe(null);
  });
});
