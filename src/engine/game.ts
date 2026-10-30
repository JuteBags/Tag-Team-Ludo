// Turn flow: roll -> (move) -> next roll. Pure functions over GameState.
import { BASE, COLORS, FINISHED, SEATS, type Color } from './board';
import { rollDice } from './dice';
import { applyMove, isDone, legalMoves } from './rules';
import type { GameState, Move, Rng } from './types';

/** One colour in a game and who plays it. Colours with the same owner are one person's houses. */
export interface Seat {
  color: Color;
  owner: number;
  bot: boolean;
}

/** A game with these seats (kept in clockwise turn order), started by `first` (default: the first seat). */
export function createGame(seats: Seat[], first?: Color): GameState {
  const players = [...seats]
    .sort((a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color))
    .map((s) => ({ ...s, tokens: [BASE, BASE, BASE, BASE] }));
  return {
    players,
    current: Math.max(0, first ? players.findIndex((p) => p.color === first) : 0),
    phase: 'roll',
    dice: null,
    sixes: 0,
    moves: [],
    ranking: [],
    turnCount: 0,
    event: null,
  };
}

/** The classic game: one colour per person, Blue first. */
export function newGame(playerCount: 2 | 3 | 4, humans: Color[] = ['blue']): GameState {
  return createGame(SEATS[playerCount].map((color, owner) => ({ color, owner, bot: !humans.includes(color) })));
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

  // The game ends when only one person still has tokens out; their unfinished colours rank last.
  const left = players.filter((p) => !isDone(p));
  if (new Set(left.map((p) => p.owner)).size <= 1) {
    for (const p of left) ranking.push(p.color);
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

/**
 * People in finishing order: a person is done when all their colours are home, so they rank by their
 * last colour to finish. Anyone still playing comes after, by total progress.
 */
export function ownerRanking(state: GameState): number[] {
  const owners = [...new Set(state.players.map((p) => p.owner))];
  const mine = (o: number) => state.players.filter((p) => p.owner === o);
  // Done means every token home (the last person's colours join `ranking` at game end unfinished).
  const done = (o: number) => mine(o).every(isDone);
  const place = (o: number) => Math.max(...mine(o).map((p) => state.ranking.indexOf(p.color)));
  const progress = (o: number) => mine(o).reduce((a, p) => a + p.tokens.reduce((x, t) => x + Math.max(t, 0), 0), 0);
  return owners.sort((a, b) => Number(done(b)) - Number(done(a)) || (done(a) ? place(a) - place(b) : progress(b) - progress(a)));
}

export const tokensHome = (state: GameState, color: Color) =>
  state.players.find((p) => p.color === color)!.tokens.filter((t) => t === FINISHED).length;
