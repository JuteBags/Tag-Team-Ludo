// Event statistics from all-bot games, weighted dice vs fair dice. Run with `npm run sim` (not part of
// `npm test`: 3000 games per setup takes minutes). SIM_GAMES=500 npm run sim for a quick pass.
// Prints a table and checks the dice still do what src/engine/dice.ts says.
import { describe, expect, it } from 'vitest';
import { analyzeDice, chooseMove, move, newGame, roll, sampleFace, seeded, type GameState } from '../src/engine';

// No @types/node in this project, so reach the env through globalThis.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const GAMES = Number(env.SIM_GAMES ?? 3000);
const MAX_ROLLS = 5000;
const FAIR = [1, 1, 1, 1, 1, 1].map((x) => x / 6);

interface Stats {
  games: number; unfinished: number; rolls: number; sixes: number; tripleSix: number; noMove: number;
  kills: number; pairKills: number; lostProgress: number; pairMoves: number; moves: number;
  killChance: number; killHit: number; escChance: number; escHit: number; finChance: number; finHit: number;
  maxRolls: number;
}

function simulate(players: 2 | 3 | 4, weighted: boolean): Stats {
  const s: Stats = {
    games: GAMES, unfinished: 0, rolls: 0, sixes: 0, tripleSix: 0, noMove: 0, kills: 0, pairKills: 0, lostProgress: 0,
    pairMoves: 0, moves: 0, killChance: 0, killHit: 0, escChance: 0, escHit: 0, finChance: 0, finHit: 0, maxRolls: 0,
  };
  for (let g = 0; g < GAMES; g++) {
    const rng = seeded(g * 7919 + players * 31 + (weighted ? 1 : 0));
    let st: GameState = newGame(players, []);
    let rolls = 0;
    while (st.phase !== 'over' && rolls < MAX_ROLLS) {
      if (st.phase === 'roll') {
        const { weights, why } = analyzeDice(st.players, st.players[st.current]!.color, rng);
        const face = sampleFace(weighted ? weights : FAIR, rng);
        rolls++;
        s.rolls++;
        if (face === 6) s.sixes++;
        if (why.kill.length) { s.killChance++; if (why.kill.includes(face)) s.killHit++; }
        if (why.escape.length) { s.escChance++; if (why.escape.includes(face)) s.escHit++; }
        if (why.finish.length) { s.finChance++; if (why.finish.includes(face)) s.finHit++; }
        st = roll(st, rng, face);
        if (st.event?.type === 'three-sixes') s.tripleSix++;
        if (st.event?.type === 'no-move') s.noMove++;
      } else {
        const m = chooseMove(st, rng);
        s.moves++;
        if (m.kind === 'pair') s.pairMoves++;
        s.kills += m.captures.length;
        if (m.kind === 'pair') s.pairKills += m.captures.length;
        for (const c of m.captures) s.lostProgress += st.players.find((p) => p.color === c.color)!.tokens[c.token]!;
        st = move(st, m);
      }
    }
    if (st.phase !== 'over') s.unfinished++;
    s.maxRolls = Math.max(s.maxRolls, rolls);
  }
  return s;
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const num = (x: number) => x.toFixed(1);
const ROWS: [string, (s: Stats) => string][] = [
  ['rolls per game (all players)', (s) => num(s.rolls / s.games)],
  ['longest game (rolls)', (s) => String(s.maxRolls)],
  ['P(6) per roll', (s) => pct(s.sixes / s.rolls)],
  ['triple-6 cancels per game', (s) => num(s.tripleSix / s.games)],
  ['rolls with no legal move', (s) => pct(s.noMove / s.rolls)],
  ['rolls where a kill face exists', (s) => pct(s.killChance / s.rolls)],
  ['P(kill face | one exists)', (s) => pct(s.killHit / s.killChance)],
  ['kills per game', (s) => num(s.kills / s.games)],
  ['kills per 100 rolls', (s) => num((100 * s.kills) / s.rolls)],
  ['tokens killed by a pair', (s) => pct(s.pairKills / Math.max(1, s.kills))],
  ['progress lost per kill (of 56)', (s) => num(s.lostProgress / Math.max(1, s.kills))],
  ['rolls where an escape face exists', (s) => pct(s.escChance / s.rolls)],
  ['P(escape face | one exists)', (s) => pct(s.escHit / s.escChance)],
  ['P(exact-finish face | one exists)', (s) => pct(s.finHit / s.finChance)],
  ['pair moves / all moves', (s) => pct(s.pairMoves / s.moves)],
];

describe(`simulation: ${GAMES} all-bot games per setup`, () => {
  const results: Record<string, Stats> = {};

  for (const players of [2, 3, 4] as const) {
    it(`${players} players`, { timeout: 1_800_000 }, () => {
      const w = (results[`${players}p weighted`] = simulate(players, true));
      const f = (results[`${players}p fair`] = simulate(players, false));
      for (const s of [w, f]) {
        expect(s.unfinished).toBe(0); // every game ends
        expect(s.sixes / s.rolls).toBeGreaterThan(0.15);
        expect(s.sixes / s.rolls).toBeLessThan(0.19);
      }
      // The weighting must favour kills and escapes and hold back exact finishes.
      expect(w.killHit / w.killChance).toBeGreaterThan(f.killHit / f.killChance);
      expect(w.escHit / w.escChance).toBeGreaterThan(f.escHit / f.escChance);
      expect(w.finHit / w.finChance).toBeLessThan(f.finHit / f.finChance);
    });
  }

  it('prints the table', () => {
    const cols = Object.keys(results);
    const line = (cells: string[]) => cells.map((c, i) => c.padEnd(i ? 14 : 36)).join('');
    console.log(['', line(['metric', ...cols]), ...ROWS.map(([name, f]) => line([name, ...cols.map((c) => f(results[c]!))]))].join('\n'));
  });
});
