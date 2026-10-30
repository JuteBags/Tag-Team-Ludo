// Move generation, captures, blocks and threats. See docs/RULES.md.
import { BASE, FINISHED, HOME_FIRST, LAST_TRACK, isSafe, squareOf, type Color } from './board';
import type { Capture, Move, PlayerState } from './types';

export function playerOf(players: PlayerState[], color: Color): PlayerState {
  const p = players.find((pl) => pl.color === color);
  if (!p) throw new Error(`no player ${color}`);
  return p;
}

/** How many of `color`'s tokens stand on an absolute track square. */
export function countAt(players: PlayerState[], color: Color, square: number): number {
  const p = players.find((pl) => pl.color === color);
  return p ? p.tokens.filter((t) => squareOf(color, t) === square).length : 0;
}

/** True when an enemy of `mover` has a block (2+ tokens) on a non-star square. */
export function isBlockedFor(players: PlayerState[], square: number, mover: Color): boolean {
  if (isSafe(square)) return false;
  return players.some((p) => p.color !== mover && countAt(players, p.color, square) >= 2);
}

/** Walks a token forward; null if it overshoots or meets an enemy block on the way or at the end. */
function walk(players: PlayerState[], color: Color, from: number, steps: number): { to: number; captures: Capture[] } | null {
  if (from === BASE) return null;
  const to = from + steps;
  if (to > FINISHED) return null;
  for (let p = from + 1; p <= to; p++) {
    const sq = squareOf(color, p);
    if (sq !== null && isBlockedFor(players, sq, color)) return null;
  }
  const captures: Capture[] = [];
  const sq = squareOf(color, to);
  if (sq !== null && !isSafe(sq)) {
    for (const p of players) {
      if (p.color === color) continue;
      p.tokens.forEach((t, i) => {
        if (squareOf(p.color, t) === sq) captures.push({ color: p.color, token: i });
      });
    }
  }
  return { to, captures };
}

export function legalMoves(players: PlayerState[], color: Color, roll: number): Move[] {
  const me = playerOf(players, color);
  const moves: Move[] = [];

  // One release per base token so the UI can move the exact pawn tapped.
  // Start squares are stars, so a release never captures and is never blocked.
  if (roll === 6) {
    me.tokens.forEach((t, i) => {
      if (t === BASE) moves.push({ kind: 'release', color, tokens: [i], from: BASE, to: 0, steps: 0, captures: [], finishes: 0 });
    });
  }

  // Tokens on the same square give identical single moves; offer one of them.
  const seen = new Set<number>();
  me.tokens.forEach((t, i) => {
    if (t === BASE || t === FINISHED || seen.has(t)) return;
    seen.add(t);
    const w = walk(players, color, t, roll);
    if (w) moves.push({ kind: 'single', color, tokens: [i], from: t, to: w.to, steps: roll, captures: w.captures, finishes: w.to === FINISHED ? 1 : 0 });
  });

  if (roll % 2 === 0) {
    const half = roll / 2;
    const groups = new Map<number, number[]>();
    me.tokens.forEach((t, i) => {
      if (t < 0 || t > LAST_TRACK) return; // no pairs in base or the home column
      const g = groups.get(t);
      if (g) g.push(i);
      else groups.set(t, [i]);
    });
    for (const [t, idx] of groups) {
      if (idx.length < 2) continue;
      const w = walk(players, color, t, half);
      if (w) moves.push({ kind: 'pair', color, tokens: idx.slice(0, 2), from: t, to: w.to, steps: half, captures: w.captures, finishes: w.to === FINISHED ? 2 : 0 });
    }
  }
  return moves;
}

export function applyMove(players: PlayerState[], move: Move): PlayerState[] {
  const next = players.map((p) => ({ ...p, tokens: [...p.tokens] }));
  const me = playerOf(next, move.color);
  for (const i of move.tokens) me.tokens[i] = move.to;
  for (const c of move.captures) playerOf(next, c.color).tokens[c.token] = BASE;
  return next;
}

/** Could some enemy capture `color`'s token at `progress` with a single roll of 1-6? */
export function isThreatened(players: PlayerState[], color: Color, progress: number): boolean {
  const sq = squareOf(color, progress);
  if (sq === null || isSafe(sq) || countAt(players, color, sq) >= 2) return false;
  for (const p of players) {
    if (p.color === color) continue;
    for (const e of p.tokens) {
      if (e < 0 || e > LAST_TRACK) continue;
      for (let d = 1; d <= 6 && e + d <= LAST_TRACK; d++) {
        if (squareOf(p.color, e + d) === sq && walk(players, p.color, e, d)) return true;
      }
    }
  }
  return false;
}

/** A move that takes a threatened single token to a star or into the home column. */
export function isEscape(players: PlayerState[], move: Move): boolean {
  if (move.kind !== 'single' || !isThreatened(players, move.color, move.from)) return false;
  if (move.to >= HOME_FIRST) return true;
  const sq = squareOf(move.color, move.to);
  return sq !== null && isSafe(sq);
}

export const isDone = (p: PlayerState) => p.tokens.every((t) => t === FINISHED);
