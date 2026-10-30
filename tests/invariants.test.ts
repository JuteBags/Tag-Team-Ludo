// Rule invariants, checked after every single move of hundreds of seeded games. Random move choice
// reaches odd positions that bots avoid; bot games cover realistic play. A failure names the game
// (seed) and step, so it can be replayed.
import { describe, expect, it } from 'vitest';
import {
  BASE,
  FINISHED,
  LAST_TRACK,
  chooseMove,
  countAt,
  createGame,
  isSafe,
  legalMoves,
  move,
  newGame,
  roll,
  sameSide,
  seeded,
  squareOf,
  type GameState,
  type Move,
  type PlayerState,
} from '../src/engine';

const tokensOf = (ps: PlayerState[], c: string) => ps.find((p) => p.color === c)!.tokens;

/** Every way a move could break the rules in docs/RULES.md, given the board before it. */
function moveProblems(before: PlayerState[], m: Move, dice: number): string[] {
  const bad: string[] = [];
  const mine = tokensOf(before, m.color);
  if (m.kind === 'release') {
    if (dice !== 6) bad.push('release without a 6');
    if (mine[m.tokens[0]!] !== BASE || m.to !== 0) bad.push('release not from base to the start square');
    return bad;
  }
  for (const i of m.tokens) if (mine[i] !== m.from) bad.push(`token ${i} is not on the square it moves from`);
  if (m.to > FINISHED) bad.push('overshoots the centre');
  const fromSq = squareOf(m.color, m.from);
  const toSq = squareOf(m.color, m.to);
  if (m.kind === 'pair') {
    if (dice % 2) bad.push('pair moved on an odd roll');
    if (m.steps !== dice / 2 || m.tokens.length !== 2) bad.push('pair does not move half the roll each');
    if (m.from > LAST_TRACK) bad.push('pair in the home column');
    for (const c of m.captures) if (countAt(before, c.color, toSq!) < 2) bad.push('pair captured a single');
    if (m.captures.length % 2) bad.push('pair captured an odd number of tokens');
  } else {
    if (m.steps !== dice) bad.push('single does not move the full roll');
    // A locked double (even count on a normal square) never splits.
    if (fromSq !== null && !isSafe(fromSq) && countAt(before, m.color, fromSq) % 2 === 0) bad.push('locked double split');
    // A single never jumps an enemy (another person's) double on a normal square.
    for (let p = m.from + 1; p < m.to; p++) {
      const sq = squareOf(m.color, p);
      if (sq === null || isSafe(sq)) continue;
      if (before.some((o) => !sameSide(before, o.color, m.color) && countAt(before, o.color, sq) >= 2)) bad.push(`single jumped an enemy double at ${sq}`);
    }
    if (m.captures.length > before.length - 1) bad.push('single captured more than one token per colour');
    for (const c of m.captures) if (countAt(before, c.color, toSq!) % 2 === 0) bad.push('single captured a token that is part of a double');
  }
  if (m.captures.length && (toSq === null || isSafe(toSq))) bad.push('capture on a star or in the home column');
  for (const c of m.captures) {
    if (c.color === m.color) bad.push('captured its own token');
    if (sameSide(before, c.color, m.color)) bad.push("captured a teammate's token");
    if (squareOf(c.color, tokensOf(before, c.color)[c.token]!) !== toSq) bad.push('captured a token that is not on the landing square');
  }
  return bad;
}

function boardProblems(ps: PlayerState[]): string[] {
  const bad: string[] = [];
  for (const p of ps) {
    if (p.tokens.length !== 4) bad.push(`${p.color} has ${p.tokens.length} tokens`);
    for (const t of p.tokens) if (!Number.isInteger(t) || t < BASE || t > FINISHED) bad.push(`${p.color} token at ${t}`);
  }
  return bad;
}

type Policy = (st: GameState, rng: () => number) => Move;
const randomMove: Policy = (st, rng) => st.moves[Math.floor(rng() * st.moves.length)]!;
const botMove: Policy = (st, rng) => chooseMove(st, rng);

/** Plays one game and returns the first broken rule, or null. */
function playChecked(seed: number, players: 2 | 3 | 4, policy: Policy, start?: GameState): string | null {
  const rng = seeded(seed);
  let st = start ?? newGame(players, []);
  for (let step = 0; step < 6000; step++) {
    if (st.phase === 'over') {
      const r = st.ranking;
      if (new Set(r).size !== r.length || r.length !== st.players.length) return `step ${step}: ranking ${r.join(',')}`;
      return null;
    }
    if (st.phase === 'roll') {
      const before = st;
      st = roll(st, rng);
      const ev = st.event;
      if (st.dice! < 1 || st.dice! > 6) return `step ${step}: rolled ${st.dice}`;
      const legal = legalMoves(before.players, before.players[before.current]!.color, st.dice!);
      if (ev?.type === 'no-move' && legal.length) return `step ${step}: "no move" with ${legal.length} legal moves`;
      if (ev?.type === 'rolled' && JSON.stringify(st.moves) !== JSON.stringify(legal)) return `step ${step}: offered moves differ from the rules`;
      if (ev?.type === 'three-sixes' && before.sixes !== 2) return `step ${step}: three sixes after ${before.sixes} sixes`;
      continue;
    }
    const m = policy(st, rng);
    const problems = moveProblems(st.players, m, st.dice!);
    const after = move(st, m);
    problems.push(...boardProblems(after.players));
    for (const i of m.tokens) if (tokensOf(after.players, m.color)[i] !== m.to) problems.push(`token ${i} did not end on ${m.to}`);
    for (const c of m.captures) if (tokensOf(after.players, c.color)[c.token] !== BASE) problems.push('captured token not sent home');
    const ev = after.event;
    if (ev?.type === 'moved' && after.phase !== 'over') {
      const done = after.players[st.current]!.tokens.every((t) => t === FINISHED);
      const earned = !done && (st.dice === 6 || m.captures.length > 0 || m.finishes > 0);
      if (ev.extraTurn !== earned) problems.push(`extra roll ${ev.extraTurn}, earned ${earned}`);
      if (earned && after.current !== st.current) problems.push('extra roll went to someone else');
    }
    if (problems.length) return `step ${step} (${m.kind} ${m.color} ${m.from}->${m.to}, dice ${st.dice}): ${problems.join('; ')}`;
    st = after;
  }
  return 'never finished';
}

describe('rule invariants under random play', () => {
  for (const players of [2, 3, 4] as const) {
    it(`${players} players: 150 games, every move checked`, { timeout: 120_000 }, () => {
      for (let g = 0; g < 150; g++) expect(playChecked(1000 * players + g, players, randomMove), `seed ${1000 * players + g}`).toBeNull();
    });
  }
});

describe('rule invariants under bot play', () => {
  for (const players of [2, 3, 4] as const) {
    it(`${players} players: 60 games, every move checked`, { timeout: 120_000 }, () => {
      for (let g = 0; g < 60; g++) expect(playChecked(5000 * players + g, players, botMove), `seed ${5000 * players + g}`).toBeNull();
    });
  }
});

describe('rule invariants with two houses each', () => {
  // Two people, each with two houses: opposite pairs, then adjacent pairs.
  const pairs = [
    ['blue', 'red'],
    ['blue', 'green'],
  ] as const;
  for (const mine of pairs) {
    it(`${mine.join(' + ')} vs the rest: 100 random games, every move checked`, { timeout: 120_000 }, () => {
      for (let g = 0; g < 100; g++) {
        const seats = (['blue', 'green', 'red', 'yellow'] as const).map((color) => ({ color, owner: (mine as readonly string[]).includes(color) ? 0 : 1, bot: true }));
        expect(playChecked(9000 + g, 4, randomMove, createGame(seats)), `seed ${9000 + g}`).toBeNull();
      }
    });
  }
});
