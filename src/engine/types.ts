import type { Color } from './board';

/** Returns a float in [0, 1). */
export type Rng = () => number;

/** How well a bot plays. Only changes how it picks moves, never the dice. */
export type BotLevel = 'easy' | 'normal' | 'hard';

export interface PlayerState {
  color: Color;
  /** The person (seat) playing this colour. A person with two houses owns two colours; they are one side. */
  owner: number;
  bot: boolean;
  /** A bot's level (normal when missing). */
  level?: BotLevel;
  /** Progress of each of the 4 tokens: -1 base, 0-50 track, 51-55 home column, 56 finished. */
  tokens: number[];
}

export interface Capture {
  color: Color;
  token: number;
}

export type MoveKind = 'release' | 'single' | 'pair';

export interface Move {
  kind: MoveKind;
  color: Color;
  /** Token indices that move (two for a pair). */
  tokens: number[];
  from: number;
  to: number;
  /** Steps each token moves (half the roll for a pair). */
  steps: number;
  captures: Capture[];
  /** Tokens that reach the centre with this move. */
  finishes: number;
}

export type GameEvent =
  | { type: 'rolled'; color: Color; dice: number }
  | { type: 'no-move'; color: Color; dice: number }
  | { type: 'three-sixes'; color: Color }
  | { type: 'moved'; move: Move; extraTurn: boolean }
  | { type: 'game-over'; ranking: Color[] };

export interface GameState {
  players: PlayerState[];
  /** Index into players of whoever acts next. */
  current: number;
  phase: 'roll' | 'move' | 'over';
  dice: number | null;
  /** Consecutive sixes rolled by the current player this turn. */
  sixes: number;
  /** Legal moves for the current dice; non-empty only in the 'move' phase. */
  moves: Move[];
  /** Colours in the order they finished all four tokens. */
  ranking: Color[];
  turnCount: number;
  event: GameEvent | null;
  /** Doubles are off: classic single-token Ludo (RULES.md section I). Missing in older saved games. */
  singles?: boolean;
}
