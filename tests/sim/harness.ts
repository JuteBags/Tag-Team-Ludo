// Shared harness for the all-bot simulations in tests/sim/*.sim.ts (npm run sim). Each file lists its
// setups and calls runSimulation; CI runs every file in parallel, on main and on the pull request, and
// tools/sim-compare.mjs turns the "SIM_JSON {...}" line each file prints into one section of the PR comment.
// Every setup is played with the game's weighted dice and with fair dice, so the effect of the weighting
// is visible, and checked: every game ends and the dice behave as src/engine/dice.ts says.
import { describe, expect, it } from 'vitest';
import { BASE, analyzeDice, chooseMove, move, roll, sampleFace, seeded, type Color, type GameState } from '../../src/engine';

// No @types/node in this project, so reach the env through globalThis.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
export const GAMES = Number(env.SIM_GAMES ?? 3000);
const MAX_ROLLS = 5000;
const FAIR = [1, 1, 1, 1, 1, 1].map((x) => x / 6);
/** The seat a human plays. Every seat is a bot here, but this one is watched as "the player's view". */
const SEAT: Color = 'blue';

export interface Setup {
  /** Column name in the report, e.g. "2p". */
  name: string;
  /** Seed offset, so setups don't share games. */
  seed: number;
  make: () => GameState;
}

interface Stats {
  games: number; unfinished: number; rolls: number; sixes: number; tripleSix: number; noMove: number;
  kills: number; pairKills: number; lostProgress: number; pairMoves: number; moves: number;
  killChance: number; killHit: number; escChance: number; escHit: number; finChance: number; finHit: number;
  maxRolls: number;
  // The player's view: the watched seat only.
  seatRolls: number; seatNoMove: number; seatAllHome: number; seatKills: number; seatLost: number;
  seatWins: number; seatPlaceSum: number; seatIdleStreak: number;
}

function simulate(setup: Setup, weighted: boolean): Stats {
  const s: Stats = {
    games: GAMES, unfinished: 0, rolls: 0, sixes: 0, tripleSix: 0, noMove: 0, kills: 0, pairKills: 0, lostProgress: 0,
    pairMoves: 0, moves: 0, killChance: 0, killHit: 0, escChance: 0, escHit: 0, finChance: 0, finHit: 0, maxRolls: 0,
    seatRolls: 0, seatNoMove: 0, seatAllHome: 0, seatKills: 0, seatLost: 0, seatWins: 0, seatPlaceSum: 0, seatIdleStreak: 0,
  };
  for (let g = 0; g < GAMES; g++) {
    const rng = seeded(g * 7919 + setup.seed + (weighted ? 1 : 0));
    let st: GameState = setup.make();
    const mine = (c: Color) => c === SEAT;
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
        const seat = mine(color);
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
        if (mine(color)) idle = 0;
        if (m.kind === 'pair') s.pairMoves++;
        s.kills += m.captures.length;
        if (m.kind === 'pair') s.pairKills += m.captures.length;
        if (mine(color)) s.seatKills += m.captures.length;
        for (const c of m.captures) {
          s.lostProgress += st.players.find((p) => p.color === c.color)!.tokens[c.token]!;
          if (mine(c.color)) s.seatLost++;
        }
        st = move(st, m);
      }
    }
    if (st.phase !== 'over') s.unfinished++;
    const place = st.ranking.indexOf(SEAT) + 1 || st.players.length;
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

/** Plays every setup with game dice and fair dice, checks them, and prints the table and the SIM_JSON line. */
export function runSimulation(title: string, setups: Setup[]) {
  describe(`${title}: ${GAMES} all-bot games per setup`, () => {
    const results: Record<string, Stats> = {};

    for (const setup of setups) {
      it(setup.name, { timeout: 1_800_000 }, () => {
        const w = (results[`${setup.name} weighted`] = simulate(setup, true));
        const f = (results[`${setup.name} fair`] = simulate(setup, false));
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
      const line = (cells: string[]) => cells.map((c, i) => c.padEnd(i ? Math.max(14, c.length + 2) : 44)).join('');
      console.log(['', title, line(['metric', ...cols]), ...METRICS.map((m) => line([m.label, ...cols.map((c) => show(m, m.f(results[c]!)))]))].join('\n'));
      const json = {
        title,
        games: GAMES,
        metrics: METRICS.map(({ key, label, pct }) => ({ key, label, pct: !!pct })),
        setups: Object.fromEntries(cols.map((c) => [c, Object.fromEntries(METRICS.map((m) => [m.key, m.f(results[c]!)]))])),
      };
      console.log(`SIM_JSON ${JSON.stringify(json)}`);
    });
  });
}
