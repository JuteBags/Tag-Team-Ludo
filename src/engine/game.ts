// Turn flow: roll -> (move) -> next roll. Pure functions over GameState.
import { BASE, FINISHED, SEATS, type Color } from './board';
import { rollDice } from './dice';
import { applyMove, isDone, legalMoves } from './rules';
import type { GameState, Move, Rng } from './types';

export function newGame(playerCount: 2 | 3 | 4, humans: Color[] = ['blue']): GameState {
  return {
    players: SEATS[playerCount].map((color) => ({ color, bot: !humans.includes(color), tokens: [BASE, BASE, BASE, BASE] })),
    current: 0,
    phase: 'roll',
    dice: null,
    sixes: 0,
    moves: [],
    ranking: [],
    turnCount: 0,
    event: null,
  };
}

function nextPlayer(state: GameState): number {
  const n = state.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (state.current + k) % n;
    if (!isDone(state.players[i]!)) return i;
  }
  return state.current;
}

const passTurn = (state: GameState): Pick<GameState, 'current' | 'sixes' | 'turnCount' | 'phase' | 'moves'> => ({
  current: nextPlayer(state),
  sixes: 0,
  turnCount: state.turnCount + 1,
  phase: 'roll',
  moves: [],
});

/** Rolls for the current player. `forced` fixes the face (tests, replays). */
export function roll(state: GameState, rng: Rng, forced?: number): GameState {
  if (state.phase !== 'roll') throw new Error(`cannot roll in phase ${state.phase}`);
  const color = state.players[state.current]!.color;
  const dice = forced ?? rollDice(state.players, color, rng);
  const sixes = dice === 6 ? state.sixes + 1 : 0;

  if (sixes === 3) return { ...state, ...passTurn(state), dice, event: { type: 'three-sixes', color } };

  const moves = legalMoves(state.players, color, dice);
  if (moves.length === 0) {
    const event = { type: 'no-move', color, dice } as const;
    // A six still earns another roll even when nothing can move.
    return dice === 6 ? { ...state, dice, sixes, moves: [], event } : { ...state, ...passTurn(state), dice, event };
  }
  return { ...state, dice, sixes, moves, phase: 'move', event: { type: 'rolled', color, dice } };
}

export function move(state: GameState, m: Move): GameState {
  if (state.phase !== 'move') throw new Error(`cannot move in phase ${state.phase}`);
  const key = JSON.stringify(m);
  if (!state.moves.some((x) => JSON.stringify(x) === key)) throw new Error('illegal move');

  const players = applyMove(state.players, m);
  const me = players[state.current]!;
  const ranking = [...state.ranking];
  if (isDone(me)) ranking.push(me.color);

  const left = players.filter((p) => !isDone(p));
  if (left.length <= 1) {
    if (left[0]) ranking.push(left[0].color);
    return { ...state, players, ranking, phase: 'over', moves: [], event: { type: 'game-over', ranking } };
  }

  const extraTurn = !isDone(me) && (state.dice === 6 || m.captures.length > 0 || m.finishes > 0);
  const after = { ...state, players, ranking };
  return extraTurn
    ? { ...after, phase: 'roll', moves: [], event: { type: 'moved', move: m, extraTurn } }
    : { ...after, ...passTurn(after), event: { type: 'moved', move: m, extraTurn } };
}

/** Finishing order first, then anyone still playing by total progress. */
export function finalRanking(state: GameState): Color[] {
  const progress = (c: Color) => state.players.find((p) => p.color === c)!.tokens.reduce((a, t) => a + Math.max(t, 0), 0);
  const rest = state.players.map((p) => p.color).filter((c) => !state.ranking.includes(c));
  return [...state.ranking, ...rest.sort((a, b) => progress(b) - progress(a))];
}

export const tokensHome = (state: GameState, color: Color) =>
  state.players.find((p) => p.color === color)!.tokens.filter((t) => t === FINISHED).length;
