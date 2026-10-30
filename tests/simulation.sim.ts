// Event statistics from all-bot games, weighted dice vs fair dice. Run with `npm run sim` (not part of
// `npm test`: 3000 games per setup takes minutes). SIM_GAMES=500 npm run sim for a quick pass.
// Prints a table and checks the dice still do what src/engine/dice.ts says. It also prints one line
// "SIM_JSON {...}" with every metric as a number, which CI compares between main and a pull request
// (tools/sim-compare.mjs).
import { describe, expect, it } from 'vitest';
import { BASE, analyzeDice, chooseMove, move, newGame, roll, sampleFace, seeded, type GameState } from '../src/engine';

// No @types/node in this project, so reach the env through globalThis.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const GAMES = Number(env.SIM_GAMES ?? 3000);
const MAX_ROLLS = 5000;
const FAIR = [1, 1, 1, 1, 1, 1].map((x) => x / 6);
/** The seat a human plays. Every seat is a bot here, but this one is watched as "the player's view". */
const SEAT = 'blue';

interface Stats {
  games: number; unfinished: number; rolls: number; sixes: number; tripleSix: number; noMove: number;
  kills: number; pairKills: number; lostProgress: number; pairMoves: number; moves: number;
  killChance: number; killHit: number; escChance: number; escHit: number; finChance: number; finHit: number;
  maxRolls: number;
  // The player's view: the watched seat only.
  seatRolls: number; seatNoMove: number; seatAllHome: number; seatKills: number; seatLost: number;
  seatWins: number; seatPlaceSum: number; seatIdleStreak: number;
}

function simulate(players: 2 | 3 | 4, weighted: boolean): Stats {
  const s: Stats = {
    games: GAMES, unfinished: 0, rolls: 0, sixes: 0, tripleSix: 0, noMove: 0, kills: 0, pairKills: 0, lostProgress: 0,
    pairMoves: 0, moves: 0, killChance: 0, killHit: 0, escChance: 0, escHit: 0, finChance: 0, finHit: 0, maxRolls: 0,
    seatRolls: 0, seatNoMove: 0, seatAllHome: 0, seatKills: 0, seatLost: 0, seatWins: 0, seatPlaceSum: 0, seatIdleStreak: 0,
  };
  for (let g = 0; g < GAMES; g++) {
    const rng = seeded(g * 7919 + players * 31 + (weighted ? 1 : 0));
    let st: GameState = newGame(players, []);
    let rolls = 0;
    let idle = 0;
    while (st.phase !== 'over' && rolls < MAX_ROLLS) {
      const color = st.players[st.current]!.color;
      if (st.phase === 'roll') {
        const { weights, why } = analyzeDice(st.players, color, rng);
        const face = sampleFace(weighted ? weights : FAIR, rng);
        rolls++;
        s.rolls++;
        if (face === 6) s.sixes++;
        if (why.kill.length) { s.killChance++; if (why.kill.includes(face)) s.killHit++; }
        if (why.escape.length) { s.escChance++; if (why.escape.includes(face)) s.escHit++; }
        if (why.finish.length) { s.finChance++; if (why.finish.includes(face)) s.finHit++; }
        const seat = color === SEAT;
        if (seat) {
          s.seatRolls++;
          if (st.players[st.current]!.tokens.every((t) => t === BASE)) s.seatAllHome++;
        }
        st = roll(st, rng, face);
        if (st.event?.type === 'three-sixes') s.tripleSix++;
        if (st.event?.type === 'no-move') {
          s.noMove++;
          if (seat) {
            s.seatNoMove++;
            s.seatIdleStreak = Math.max(s.seatIdleStreak, ++idle);
          }
        }
      } else {
        const m = chooseMove(st, rng);
        s.moves++;
        if (color === SEAT) idle = 0;
        if (m.kind === 'pair') s.pairMoves++;
        s.kills += m.captures.length;
        if (m.kind === 'pair') s.pairKills += m.captures.length;
        if (color === SEAT) s.seatKills += m.captures.length;
        for (const c of m.captures) {
          s.lostProgress += st.players.find((p) => p.color === c.color)!.tokens[c.token]!;
          if (c.color === SEAT) s.seatLost++;
        }
        st = move(st, m);
      }
    }
    if (st.phase !== 'over') s.unfinished++;
    const place = st.ranking.indexOf(SEAT) + 1 || players;
    if (place === 1) s.seatWins++;
    s.seatPlaceSum += place;
    s.maxRolls = Math.max(s.maxRolls, rolls);
  }
  return s;
}

/** Every metric, as a number. `pct` ones are shown as percentages. */
export const METRICS: { key: string; label: string; pct?: boolean; f: (s: Stats) => number }[] = [
  { key: 'rollsPerGame', label: 'Rolls per game (all players)', f: (s) => s.rolls / s.games },
  { key: 'longestGame', label: 'Longest game (rolls)', f: (s) => s.maxRolls },
  { key: 'six', label: 'P(6) per roll', pct: true, f: (s) => s.sixes / s.rolls },
  { key: 'tripleSix', label: 'Triple-6 cancels per game', f: (s) => s.tripleSix / s.games },
  { key: 'noMove', label: 'Rolls with no legal move', pct: true, f: (s) => s.noMove / s.rolls },
  { key: 'killChance', label: 'Rolls where a kill is possible', pct: true, f: (s) => s.killChance / s.rolls },
  { key: 'killHit', label: 'P(kill face | one exists)', pct: true, f: (s) => s.killHit / s.killChance },
  { key: 'kills', label: 'Kills per game', f: (s) => s.kills / s.games },
  { key: 'killsPer100', label: 'Kills per 100 rolls', f: (s) => (100 * s.kills) / s.rolls },
  { key: 'pairKills', label: 'Tokens killed by a pair', pct: true, f: (s) => s.pairKills / Math.max(1, s.kills) },
  { key: 'lostPerKill', label: 'Progress lost per kill (of 56)', f: (s) => s.lostProgress / Math.max(1, s.kills) },
  { key: 'escChance', label: 'Rolls where an escape is possible', pct: true, f: (s) => s.escChance / s.rolls },
  { key: 'escHit', label: 'P(escape face | one exists)', pct: true, f: (s) => s.escHit / s.escChance },
  { key: 'finHit', label: 'P(exact-finish face | one exists)', pct: true, f: (s) => s.finHit / s.finChance },
  { key: 'pairMoves', label: 'Pair moves / all moves', pct: true, f: (s) => s.pairMoves / s.moves },
  { key: 'seatWin', label: 'Player: win rate', pct: true, f: (s) => s.seatWins / s.games },
  { key: 'seatPlace', label: 'Player: average finishing place', f: (s) => s.seatPlaceSum / s.games },
  { key: 'seatKills', label: 'Player: kills made per game', f: (s) => s.seatKills / s.games },
  { key: 'seatLost', label: 'Player: tokens lost per game', f: (s) => s.seatLost / s.games },
  { key: 'seatIdle', label: 'Player: rolls with no move', pct: true, f: (s) => s.seatNoMove / Math.max(1, s.seatRolls) },
  { key: 'seatAllHome', label: 'Player: rolls with every token at home', pct: true, f: (s) => s.seatAllHome / Math.max(1, s.seatRolls) },
  { key: 'seatIdleStreak', label: 'Player: longest run of turns without a move', f: (s) => s.seatIdleStreak },
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

  it('prints the table and the numbers for CI', () => {
    const cols = Object.keys(results);
    const show = (m: (typeof METRICS)[number], v: number) => (m.pct ? `${(100 * v).toFixed(1)}%` : v.toFixed(1));
    const line = (cells: string[]) => cells.map((c, i) => c.padEnd(i ? 14 : 44)).join('');
    console.log(['', line(['metric', ...cols]), ...METRICS.map((m) => line([m.label, ...cols.map((c) => show(m, m.f(results[c]!)))]))].join('\n'));
    const json = {
      games: GAMES,
      metrics: METRICS.map(({ key, label, pct }) => ({ key, label, pct: !!pct })),
      setups: Object.fromEntries(cols.map((c) => [c, Object.fromEntries(METRICS.map((m) => [m.key, m.f(results[c]!)]))])),
    };
    console.log(`SIM_JSON ${JSON.stringify(json)}`);
  });
});
