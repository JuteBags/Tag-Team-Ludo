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
  /** The die from the tray this move uses. */
  roll: number;
  captures: Capture[];
  /** Tokens that reach the centre with this move. */
  finishes: number;
}

export type GameEvent =
  | { type: 'rolled'; color: Color; dice: number }
  | { type: 'no-move'; color: Color; dice: number }
  | { type: 'three-sixes'; color: Color }
  /** `extraTurn`: a capture or a token home rolls again. `lost`: dice left in the tray that nothing could use. */
  | { type: 'moved'; move: Move; extraTurn: boolean; lost: number[] }
  | { type: 'game-over'; ranking: Color[] };

export interface GameState {
  players: PlayerState[];
  /** Index into players of whoever acts next. */
  current: number;
  phase: 'roll' | 'move' | 'over';
  /** The face just rolled. */
  dice: number | null;
  /** The tray: this turn's rolls not played yet. A turn is rolled first (a 6 rolls again), then played. */
  rolls: number[];
  /** Sixes in a row in the current run of rolls. */
  sixes: number;
  /** Legal moves for every die in the tray; non-empty only in the 'move' phase. */
  moves: Move[];
  /** Colours in the order they finished all four tokens. */
  ranking: Color[];
  turnCount: number;
  event: GameEvent | null;
  /** Doubles are off: classic single-token Ludo (RULES.md section I). Missing in older saved games. */
  singles?: boolean;
}
