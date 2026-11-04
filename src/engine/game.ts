// Turn flow: roll the whole turn into the tray (a 6 rolls again), then play the tray's dice in any order;
// a capture or a token home rolls again first. Pure functions over GameState. See docs/RULES.md section C.
import { BASE, COLORS, FINISHED, SEATS, type Color } from './board';
import { rollDice } from './dice';
import { applyMove, isDone, legalMoves } from './rules';
import type { BotLevel, GameState, Move, PlayerState, Rng } from './types';

/** One colour in a game and who plays it. Colours with the same owner are one person's houses. */
export interface Seat {
  color: Color;
  owner: number;
  bot: boolean;
  /** A bot's level (normal when missing). */
  level?: BotLevel;
}

/**
 * A game with these seats (kept in clockwise turn order), started by `first` (default: the first seat).
 * `singles` turns doubles off.
 */
export function createGame(seats: Seat[], first?: Color, singles = false): GameState {
  const players = [...seats]
    .sort((a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color))
    .map((s) => ({ ...s, tokens: [BASE, BASE, BASE, BASE] }));
  return {
    players,
    current: Math.max(0, first ? players.findIndex((p) => p.color === first) : 0),
    phase: 'roll',
    dice: null,
    rolls: [],
    sixes: 0,
    moves: [],
    ranking: [],
    turnCount: 0,
    event: null,
    singles,
  };
}

/** The classic game: one colour per person, Blue first. */
export function newGame(playerCount: 2 | 3 | 4, humans: Color[] = ['blue'], singles = false): GameState {
  return createGame(SEATS[playerCount].map((color, owner) => ({ color, owner, bot: !humans.includes(color) })), undefined, singles);
}

function nextPlayer(state: GameState): number {
  const n = state.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (state.current + k) % n;
    if (!isDone(state.players[i]!)) return i;
  }
  return state.current;
}

const passTurn = (state: GameState): Pick<GameState, 'current' | 'rolls' | 'sixes' | 'turnCount' | 'phase' | 'moves'> => ({
  current: nextPlayer(state),
  rolls: [],
  sixes: 0,
  turnCount: state.turnCount + 1,
  phase: 'roll',
  moves: [],
});

/** Legal moves for every distinct die in the tray, biggest die first. */
export function trayMoves(players: GameState['players'], color: Color, rolls: number[], singles = false): Move[] {
  return [...new Set(rolls)].sort((a, b) => b - a).flatMap((r) => legalMoves(players, color, r, singles));
}

/**
 * Rolls for the current player and puts the die in the tray. A 6 rolls again before anything moves.
 * The third 6 in a row cancels those three 6s only: dice kept from before (rolled before a kill) stay
 * and can still be played; with nothing else in the tray the turn passes. `forced` fixes the face.
 */
export function roll(state: GameState, rng: Rng, forced?: number): GameState {
  if (state.phase !== 'roll') throw new Error(`cannot roll in phase ${state.phase}`);
  const color = state.players[state.current]!.color;
  const dice = forced ?? rollDice(state.players, color, rng, state.singles);
  const sixes = dice === 6 ? state.sixes + 1 : 0;

  if (sixes === 3) {
    // This run's first two 6s are the last two dice in the tray.
    const kept = state.rolls.slice(0, -2);
    const moves = trayMoves(state.players, color, kept, state.singles);
    const event = { type: 'three-sixes', color } as const;
    return moves.length ? { ...state, dice, rolls: kept, sixes: 0, moves, phase: 'move', event } : { ...state, ...passTurn(state), dice, event };
  }

  const rolls = [...state.rolls, dice];
  if (dice === 6) return { ...state, dice, rolls, sixes, moves: [], event: { type: 'rolled', color, dice } };
  const moves = trayMoves(state.players, color, rolls, state.singles);
  if (moves.length === 0) return { ...state, ...passTurn(state), dice, event: { type: 'no-move', color, dice } };
  return { ...state, dice, rolls, sixes, moves, phase: 'move', event: { type: 'rolled', color, dice } };
}

export function move(state: GameState, m: Move): GameState {
  if (state.phase !== 'move') throw new Error(`cannot move in phase ${state.phase}`);
  // The same object from state.moves skips the deep compare (bots and the search pass those).
  if (!state.moves.includes(m)) {
    const key = JSON.stringify(m);
    if (!state.moves.some((x) => JSON.stringify(x) === key)) throw new Error('illegal move');
  }

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

  // The move's die leaves the tray.
  const rolls = [...state.rolls];
  rolls.splice(rolls.indexOf(m.roll), 1);
  const after = { ...state, players, ranking, rolls };
  // A capture or a token home rolls again right away; the new dice join what's left in the tray.
  const extraTurn = !isDone(me) && (m.captures.length > 0 || m.finishes > 0);
  if (extraTurn) return { ...after, phase: 'roll', sixes: 0, moves: [], event: { type: 'moved', move: m, extraTurn, lost: [] } };
  const moves = isDone(me) ? [] : trayMoves(players, me.color, rolls, state.singles);
  if (moves.length) return { ...after, moves, event: { type: 'moved', move: m, extraTurn, lost: [] } };
  // Nothing left that can move: the turn passes and any dice still in the tray are lost.
  return { ...after, ...passTurn(after), event: { type: 'moved', move: m, extraTurn, lost: isDone(me) ? [] : rolls } };
}

/**
 * How a player still playing ranks when the game ends early (RULES.md rules 34 and 41, #140), best first: more
 * tokens home; then the better board, the most progress of the tokens not yet home; then fewer in base. Ties
 * after that keep turn order. For a person with two houses, both houses' tokens count together.
 */
function unfinishedOrder(a: PlayerState[], b: PlayerState[]): number {
  const all = (ps: PlayerState[]) => ps.flatMap((p) => p.tokens);
  const home = (ps: PlayerState[]) => all(ps).filter((t) => t === FINISHED).length;
  const board = (ps: PlayerState[]) => all(ps).reduce((s, t) => s + (t === FINISHED ? 0 : Math.max(t, 0)), 0);
  const base = (ps: PlayerState[]) => all(ps).filter((t) => t === BASE).length;
  return home(b) - home(a) || board(b) - board(a) || base(a) - base(b);
}

/** Finishing order first, then anyone still playing by unfinishedOrder (turn order on a full tie). */
export function finalRanking(state: GameState): Color[] {
  const of = (c: Color) => [state.players.find((p) => p.color === c)!];
  const rest = state.players.map((p) => p.color).filter((c) => !state.ranking.includes(c));
  return [...state.ranking, ...rest.sort((a, b) => unfinishedOrder(of(a), of(b)))];
}

/**
 * People in finishing order: a person is done when all their colours are home, so they rank by their
 * last colour to finish. Anyone still playing comes after, by unfinishedOrder over all their colours (turn
 * order on a full tie: the sort is stable, and people are listed in turn order).
 */
export function ownerRanking(state: GameState): number[] {
  const owners = [...new Set(state.players.map((p) => p.owner))];
  const mine = (o: number) => state.players.filter((p) => p.owner === o);
  // Done means every token home (the last person's colours join `ranking` at game end unfinished).
  const done = (o: number) => mine(o).every(isDone);
  const place = (o: number) => Math.max(...mine(o).map((p) => state.ranking.indexOf(p.color)));
  return owners.sort((a, b) => Number(done(b)) - Number(done(a)) || (done(a) ? place(a) - place(b) : unfinishedOrder(mine(a), mine(b))));
}

export const tokensHome = (state: GameState, color: Color) =>
  state.players.find((p) => p.color === color)!.tokens.filter((t) => t === FINISHED).length;
