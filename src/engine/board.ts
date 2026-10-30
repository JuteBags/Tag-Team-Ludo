// Board constants and geometry. See docs/RULES.md.

/** Turn order, clockwise from the human's bottom-left seat. */
export const COLORS = ['blue', 'green', 'red', 'yellow'] as const;
export type Color = (typeof COLORS)[number];

/** Absolute track index (0-51) of each colour's start square. */
export const START: Record<Color, number> = { green: 0, red: 13, yellow: 26, blue: 39 };

export const TRACK_LEN = 52;
export const BASE = -1;
/** Last progress value on the shared track; 51-55 is the home column. */
export const LAST_TRACK = 50;
export const HOME_FIRST = 51;
export const FINISHED = 56;

/** Start squares plus the square 8 steps after each. */
export const SAFE_SQUARES: ReadonlySet<number> = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

export const SEATS: Record<2 | 3 | 4, readonly Color[]> = {
  2: ['blue', 'red'],
  3: ['blue', 'green', 'red'],
  4: ['blue', 'green', 'red', 'yellow'],
};

/** Absolute track square for a token, or null when it is in base, the home column or finished. */
export function squareOf(color: Color, progress: number): number | null {
  if (progress < 0 || progress > LAST_TRACK) return null;
  return (START[color] + progress) % TRACK_LEN;
}

export const isSafe = (square: number) => SAFE_SQUARES.has(square);
