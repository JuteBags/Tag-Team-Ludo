// Board layout in SVG units: 15 x 15 cells of 40 (600 x 600). Track order matches src/engine/board.ts.
import { FINISHED, LAST_TRACK, START, type Color } from '../engine';

export const CELL = 40;
export type Pt = [number, number];

/** Cell (col, row) of each absolute track square 0-51. */
export const TRACK: Pt[] = (() => {
  const p: Pt[] = [];
  for (let x = 1; x <= 5; x++) p.push([x, 6]);
  for (let y = 5; y >= 0; y--) p.push([6, y]);
  p.push([7, 0]);
  for (let y = 0; y <= 5; y++) p.push([8, y]);
  for (let x = 9; x <= 14; x++) p.push([x, 6]);
  p.push([14, 7]);
  for (let x = 14; x >= 9; x--) p.push([x, 8]);
  for (let y = 9; y <= 14; y++) p.push([8, y]);
  p.push([7, 14]);
  for (let y = 14; y >= 9; y--) p.push([6, y]);
  for (let x = 5; x >= 0; x--) p.push([x, 8]);
  p.push([0, 7], [0, 6]);
  return p;
})();

export const HOME_COL: Record<Color, Pt[]> = {
  green: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
  red: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
  yellow: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],
  blue: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
};

/** Top-left cell of each 6 x 6 base. */
export const CORNER: Record<Color, Pt> = { green: [0, 0], red: [9, 0], yellow: [9, 9], blue: [0, 9] };

/** Arrow into each home column: cell and rotation. */
export const ARROW: Record<Color, [number, number, number]> = {
  green: [0, 7, 0], red: [7, 0, 90], yellow: [14, 7, 180], blue: [7, 14, 270],
};

/** Pawn slots inside a base, relative to the base corner. */
export const SLOT: Pt[] = [[84, 82], [156, 82], [84, 154], [156, 154]];

/** Where finished tokens sit, inside each colour's centre triangle. */
const GOAL: Record<Color, Pt> = { green: [266, 300], red: [300, 266], yellow: [334, 300], blue: [300, 334] };

export const centerOf = ([x, y]: Pt): Pt => [x * CELL + 20, y * CELL + 20];

/** Board point for a token, plus a key shared by tokens standing on the same spot. */
export function spot(color: Color, progress: number, token: number): { pt: Pt; key: string } {
  if (progress < 0) {
    const [cx, cy] = CORNER[color];
    const [sx, sy] = SLOT[token]!;
    return { pt: [cx * CELL + sx, cy * CELL + sy], key: `base-${color}-${token}` };
  }
  if (progress <= LAST_TRACK) {
    const sq = (START[color] + progress) % TRACK.length;
    return { pt: centerOf(TRACK[sq]!), key: `t${sq}` };
  }
  if (progress < FINISHED) return { pt: centerOf(HOME_COL[color][progress - 51]!), key: `h-${color}-${progress}` };
  return { pt: GOAL[color], key: `goal-${color}` };
}

/** Points a token visits, one per step, when moving from `from` to `to`. */
export function stepPoints(color: Color, from: number, to: number): Pt[] {
  if (from < 0) return [spot(color, 0, 0).pt];
  const pts: Pt[] = [];
  for (let p = from + 1; p <= to; p++) pts.push(spot(color, p, 0).pt);
  return pts;
}
