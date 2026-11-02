// What the past games cost to read (#98, measured in tests): loadPastGames() parses the 20 kept records
// (reviews live under their own keys since 372e4f8), and loadReview() parses one review. bootReviews
// (reviewQueue.ts) and the Stats sheet's game list (sheets.ts) read every kept game's review. Sizes from real
// bot games, with each review filled to its real shape (every decision's gaps, every roll's luck, every
// state's chances).
import { describe, expect, it } from 'vitest';
import { createGame, move, replay, roll, rollEvent, moveEvent, seeded, seededDie, SEATS, type GameRecord, type Seat } from '../src/engine';
import { chooseBotMove } from '../src/engine/ai/levels';
import type { MoveReview, RollLuck } from '../src/engine/ai/review';
import { KEEP_GAMES, type PastGame, type StoredReview } from '../src/ui/store';

function game(seed: number, players: 2 | 4): GameRecord {
  const seats: Seat[] = SEATS[players].map((color, owner) => ({ color, owner, bot: owner !== 0, level: 'hard' }));
  const rng = seeded(seed);
  let s = createGame(seats, seats[0]!.color);
  let events = '';
  while (s.phase !== 'over') {
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
  return { v: 1, seats, first: seats[0]!.color, seed, events };
}

/** A finished review of seat 0 in its real shape: a verdict with every move's gap per decision, luck per roll, chances per state. */
function fullReview(rec: GameRecord): StoredReview {
  const { states } = replay(rec) as { states: ReturnType<typeof replay> extends { states: infer S } ? S : never };
  const owners = new Set(rec.seats.map((x) => x.owner)).size;
  const moves: MoveReview[] = [];
  const luck: RollLuck[] = [];
  states.forEach((s, at) => {
    if (s.phase === 'move' && s.players[s.current]!.owner === 0 && s.moves.length > 1)
      moves.push({ at, owner: 0, played: 0, best: 0, playedChance: 0.4123, bestChance: 0.4456, gap: 3.3, se: 0.41, label: 'good', gaps: s.moves.map((_, i) => Math.round(i * 13.7) / 10) });
    if (s.phase === 'roll') luck.push({ at, owner: s.players[s.current]!.owner, face: 3, luck: -1.234, sd: 4.567 });
  });
  const chances = states.map(() => Array.from({ length: owners }, (_, o) => 20 + o * 7));
  return { v: 3, moves, luck, chances, who: [0], when: 1_700_000_000_000, done: true };
}

const kb = (s: string) => +(s.length / 1024).toFixed(1);

describe('past games (measured)', () => {
  it('20 kept records parse small; one full review is the big read, and only on demand', () => {
    const games: PastGame[] = Array.from({ length: KEEP_GAMES }, (_, i) => ({ rec: game(100 + i, i % 2 ? 4 : 2), at: i, mode: 'pvc', place: 1 }));
    const list = JSON.stringify(games);
    let t = performance.now();
    for (let k = 0; k < 20; k++) JSON.parse(list);
    const listMs = (performance.now() - t) / 20;
    const reviews = games.map((g) => JSON.stringify(fullReview(g.rec)));
    const r4 = reviews.filter((_, i) => i % 2).map(kb);
    const r2 = reviews.filter((_, i) => !(i % 2)).map(kb);
    const big = reviews.reduce((a, r) => (r.length > a.length ? r : a));
    t = performance.now();
    for (let k = 0; k < 20; k++) JSON.parse(big);
    const reviewMs = (performance.now() - t) / 20;
    const avg = (xs: number[]) => +(xs.reduce((a, x) => a + x, 0) / xs.length).toFixed(1);
    console.log(`${KEEP_GAMES} kept records: ${kb(list)} kB JSON, parse ${listMs.toFixed(2)} ms | one full review: 2p avg ${avg(r2)} kB, 4p avg ${avg(r4)} kB, largest ${kb(big)} kB, parse ${reviewMs.toFixed(2)} ms | all ${KEEP_GAMES} reviews ${avg(reviews.map(kb)) * KEEP_GAMES} kB`);
    expect(list.length).toBeGreaterThan(0);
  }, 60_000);
});
