// docs/NOTATION.md's board diagram, generated from the board the app draws (src/ui/geometry.ts: the track
// cells and home columns) and the notation's square names, so the doc can't drift from the board (#164).
import { COLORS, START } from '../src/engine/board';
import { squareName } from '../src/engine/record';
import { CORNER, HOME_COL, TRACK } from '../src/ui/geometry';

const NAME = { blue: 'Blue', green: 'Green', red: 'Red', yellow: 'Yellow' } as const;

export function boardDiagram(): string {
  const rows = Array.from({ length: 15 }, () => Array.from({ length: 15 * 4 }, () => ' '));
  const put = (x: number, y: number, s: string) => [...s].forEach((ch, i) => (rows[y]![x + i] = ch));
  TRACK.forEach(([x, y], q) => {
    // The colour whose arm this square is on names it (the arm starts at that colour's start).
    const c = COLORS.find((k) => (q - START[k] + 52) % 52 < 13)!;
    put(x * 4, y, squareName(c, (q - START[c] + 52) % 52));
  });
  for (const c of COLORS) HOME_COL[c].forEach(([x, y], i) => put(x * 4, y, squareName(c, 51 + i)));
  for (const c of COLORS) put((CORNER[c][0] + 1) * 4 + 1, CORNER[c][1] + 2, NAME[c]);
  put(7 * 4 + 1, 7, '#');
  return rows.map((r) => r.join('').trimEnd()).join('\n');
}
