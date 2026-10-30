import { COLORS, START, newGame, type Color, type GameState, type PlayerState } from '../src/engine';

/** Players for the given colours, in turn order. */
export function mk(tokens: Partial<Record<Color, number[]>>): PlayerState[] {
  return COLORS.filter((c) => tokens[c]).map((c) => ({ color: c, bot: true, tokens: [...tokens[c]!] }));
}

/** Progress a `color` token needs to stand on absolute square `sq`. */
export const prog = (color: Color, sq: number) => (((sq - START[color]) % 52) + 52) % 52;

export function game(tokens: Partial<Record<Color, number[]>>): GameState {
  const players = mk(tokens);
  return { ...newGame(players.length as 2 | 3 | 4), players };
}

export const B = [-1, -1, -1, -1];
