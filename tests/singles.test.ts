// Doubles off (docs/RULES.md section I): every token moves alone, nothing locks or blocks, and a token
// landing on a normal square captures every enemy token there. Rule checks, then whole games where every
// move is checked against those rules.
import { describe, expect, it } from 'vitest';
import {
  BASE,
  FINISHED,
  SEATS,
  analyzeDice,
  chooseMove,
  createGame,
  isSafe,
  isThreatened,
  legalMoves,
  move,
  newGame,
  roll,
  sameSide,
  seeded,
  squareOf,
  trayMoves,
  type GameState,
  type Move,
  type PlayerState,
} from '../src/engine';
import { whyStuck } from '../src/ui/targets';
import { B, mk, prog } from './helpers';

// Blue progress 10 is square 49, a normal square; 8 is square 47, a star.
describe('doubles off', () => {
  it('never offers a pair move, and two tokens on a normal square move alone on any roll', () => {
    const ps = mk({ blue: [10, 10, -1, -1], red: B });
    expect(legalMoves(ps, 'blue', 3, true)).toEqual([expect.objectContaining({ kind: 'single', from: 10, to: 13, steps: 3 })]);
    expect(legalMoves(ps, 'blue', 4, true)).toEqual([expect.objectContaining({ kind: 'single', from: 10, to: 14, steps: 4 })]);
    // With doubles on, the same tokens are a locked pair.
    expect(legalMoves(ps, 'blue', 3)).toEqual([]);
  });

  it('lets a single pass an enemy double', () => {
    const ps = mk({ blue: [8, -1, -1, -1], red: [prog('red', 49), prog('red', 49), -1, -1] });
    expect(legalMoves(ps, 'blue', 4, true)).toEqual([expect.objectContaining({ from: 8, to: 12 })]);
    expect(legalMoves(ps, 'blue', 4)).toEqual([]);
  });

  it('captures every enemy token on the landing square', () => {
    const ps = mk({ blue: [7, -1, -1, -1], red: [prog('red', 49), prog('red', 49), -1, -1] });
    expect(legalMoves(ps, 'blue', 3, true)[0]!.captures).toEqual([{ color: 'red', token: 0 }, { color: 'red', token: 1 }]);
    // With doubles on, a single just stops on the pair.
    expect(legalMoves(ps, 'blue', 3)[0]!.captures).toEqual([]);
  });

  it('still never captures on a star or a teammate', () => {
    expect(legalMoves(mk({ blue: [3, -1, -1, -1], red: [prog('red', 47), -1, -1, -1] }), 'blue', 5, true)[0]!.captures).toEqual([]);
    const team: PlayerState[] = [
      { color: 'blue', owner: 0, bot: true, tokens: [7, -1, -1, -1] },
      { color: 'red', owner: 0, bot: true, tokens: [prog('red', 49), -1, -1, -1] },
    ];
    expect(legalMoves(team, 'blue', 3, true)[0]!.captures).toEqual([]);
  });

  it('counts a double as open to a single roll, and only single rolls as threats', () => {
    // A red token 4 behind a blue double: a 4 hits both.
    expect(isThreatened(mk({ blue: [10, 10, -1, -1], red: [prog('red', 45), -1, -1, -1] }), 'blue', 10, true)).toBe(true);
    // 9 behind is out of reach of one roll.
    expect(isThreatened(mk({ blue: [10, -1, -1, -1], red: [prog('red', 41), -1, -1, -1] }), 'blue', 10, true)).toBe(false);
  });

  it('weights the dice for kills with the singles rules', () => {
    const { why } = analyzeDice(mk({ blue: [7, -1, -1, -1], red: [prog('red', 49), prog('red', 49), -1, -1] }), 'blue', seeded(1), true);
    expect(why.kill).toContain(3);
  });

  it('never says a token is locked or blocked', () => {
    const ps = mk({ blue: [10, 10, -1, -1], red: B });
    expect(whyStuck(ps, 'blue', 0, 3)).toBe('Locked double: needs an even roll');
    expect(whyStuck(ps, 'blue', 0, 3, undefined, true)).not.toMatch(/Locked|Blocked/);
  });

  it('is kept in the game state, so a saved game keeps its rules', () => {
    expect(newGame(2, [], true).singles).toBe(true);
    expect(newGame(2, []).singles).toBe(false);
    const g = roll(createGame([{ color: 'blue', owner: 0, bot: true }, { color: 'red', owner: 1, bot: true }], 'blue', true), seeded(3), 6);
    expect(g.singles).toBe(true);
  });
});

const tokensOf = (ps: PlayerState[], c: string) => ps.find((p) => p.color === c)!.tokens;

/** Ways a move breaks the singles rules, given the board before it. */
function problems(before: PlayerState[], m: Move, dice: number): string[] {
  const bad: string[] = [];
  if (m.kind === 'pair') bad.push('pair move with doubles off');
  if (m.tokens.length !== 1) bad.push(`${m.tokens.length} tokens moved`);
  if (m.kind === 'release') return dice === 6 ? bad : [...bad, 'release without a 6'];
  if (m.steps !== dice || m.to !== m.from + dice) bad.push('did not move the full roll');
  const sq = squareOf(m.color, m.to);
  // Every enemy token on a normal landing square is captured, and nothing else.
  const expected = sq === null || isSafe(sq) ? [] : before.filter((p) => !sameSide(before, p.color, m.color)).flatMap((p) => p.tokens.flatMap((t, i) => (squareOf(p.color, t) === sq ? [`${p.color}${i}`] : [])));
  const got = m.captures.map((c) => `${c.color}${c.token}`);
  if (got.sort().join() !== expected.sort().join()) bad.push(`captured ${got.join() || 'nothing'}, expected ${expected.join() || 'nothing'}`);
  return bad;
}

function play(seed: number, start: GameState, pick: (st: GameState, rng: () => number) => Move): string | null {
  const rng = seeded(seed);
  let st = start;
  for (let step = 0; step < 6000; step++) {
    if (st.phase === 'over') return null;
    if (st.phase === 'roll') {
      st = roll(st, rng);
      continue;
    }
    if (JSON.stringify(st.moves) !== JSON.stringify(trayMoves(st.players, st.players[st.current]!.color, st.rolls, true))) return `step ${step}: offered moves differ from the rules`;
    const m = pick(st, rng);
    const bad = problems(st.players, m, m.roll);
    st = move(st, m);
    for (const c of m.captures) if (tokensOf(st.players, c.color)[c.token] !== BASE) bad.push('captured token not sent home');
    if (st.players.some((p) => p.tokens.some((t) => t < BASE || t > FINISHED))) bad.push('token off the board');
    if (bad.length) return `step ${step} (${m.color} ${m.from}->${m.to}, roll ${m.roll}): ${bad.join('; ')}`;
  }
  return 'never finished';
}

describe('whole games with doubles off', () => {
  const random = (st: GameState, rng: () => number) => st.moves[Math.floor(rng() * st.moves.length)]!;
  for (const players of [2, 3, 4] as const) {
    it(`${players} players: 80 random and 30 bot games, every move checked`, { timeout: 120_000 }, () => {
      for (let g = 0; g < 80; g++) expect(play(300 * players + g, newGame(players, [], true), random), `seed ${300 * players + g}`).toBeNull();
      for (let g = 0; g < 30; g++) expect(play(700 * players + g, newGame(players, [], true), chooseMove), `seed ${700 * players + g}`).toBeNull();
    });
  }
  it('two houses each, every bot level: 30 games', { timeout: 120_000 }, () => {
    for (let g = 0; g < 30; g++) {
      const level = (['easy', 'normal', 'hard'] as const)[g % 3];
      const seats = SEATS[4].map((color) => ({ color, owner: color === 'blue' || color === 'red' ? 0 : 1, bot: true, level }));
      expect(play(1100 + g, createGame(seats, undefined, true), chooseMove), `seed ${1100 + g}`).toBeNull();
    }
  });
});
