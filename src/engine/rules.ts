// Move generation, captures, blocks and threats. See docs/RULES.md.
//
// `singles` is a game played with doubles off (RULES.md section I): every token moves alone, nothing
// locks or blocks, and a token landing on a normal square captures every enemy token there.
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

/** True when colours `a` and `b` belong to the same person (a person with two houses is one side). */
export function sameSide(players: PlayerState[], a: Color, b: Color): boolean {
  return playerOf(players, a).owner === playerOf(players, b).owner;
}

/** True when an enemy of `mover` (another person) has a double (2+ tokens) on a non-star square. */
export function isBlockedFor(players: PlayerState[], square: number, mover: Color, singles = false): boolean {
  if (singles || isSafe(square)) return false;
  return players.some((p) => !sameSide(players, p.color, mover) && countAt(players, p.color, square) >= 2);
}

/** True when `color`'s tokens at `progress` are all locked in doubles: a normal square holding an even count. */
function isLocked(players: PlayerState[], color: Color, progress: number, singles: boolean): boolean {
  if (singles) return false;
  const sq = squareOf(color, progress);
  return sq !== null && !isSafe(sq) && countAt(players, color, sq) % 2 === 0;
}

/**
 * Walks a token (or a double) forward; null if it overshoots or a single would pass an enemy double.
 * A single may stop on an enemy double. On a normal square a single kills an enemy single and a
 * double kills an enemy double; a colour's tokens there are doubles in twos plus at most one single.
 */
function walk(players: PlayerState[], color: Color, from: number, steps: number, pair: boolean, singles: boolean): { to: number; captures: Capture[] } | null {
  if (from === BASE) return null;
  const to = from + steps;
  if (to > FINISHED) return null;
  if (!pair) {
    for (let p = from + 1; p < to; p++) {
      const sq = squareOf(color, p);
      if (sq !== null && isBlockedFor(players, sq, color, singles)) return null;
    }
  }
  const captures: Capture[] = [];
  const sq = squareOf(color, to);
  if (sq !== null && !isSafe(sq)) {
    for (const p of players) {
      if (sameSide(players, p.color, color)) continue;
      const here = p.tokens.flatMap((t, i) => (squareOf(p.color, t) === sq ? [i] : []));
      const hit = singles ? here : pair ? (here.length >= 2 ? here.slice(0, 2) : []) : here.length % 2 === 1 ? [here[here.length - 1]!] : [];
      for (const i of hit) captures.push({ color: p.color, token: i });
    }
  }
  return { to, captures };
}

export function legalMoves(players: PlayerState[], color: Color, roll: number, singles = false): Move[] {
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
  // Tokens locked in a double on a normal square can't move alone.
  const seen = new Set<number>();
  me.tokens.forEach((t, i) => {
    if (t === BASE || t === FINISHED || seen.has(t)) return;
    seen.add(t);
    if (isLocked(players, color, t, singles)) return;
    const w = walk(players, color, t, roll, false, singles);
    if (w) moves.push({ kind: 'single', color, tokens: [i], from: t, to: w.to, steps: roll, captures: w.captures, finishes: w.to === FINISHED ? 1 : 0 });
  });

  if (roll % 2 === 0 && !singles) {
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
      const w = walk(players, color, t, half, true, false);
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

/** Could some enemy capture `color`'s token(s) at `progress` with a single roll of 1-6? */
export function isThreatened(players: PlayerState[], color: Color, progress: number, singles = false): boolean {
  const sq = squareOf(color, progress);
  if (sq === null || isSafe(sq)) return false;
  const mine = playerOf(players, color).tokens;
  for (const p of players) {
    if (sameSide(players, p.color, color)) continue;
    // Only rolls that reach the square: d for a single d squares behind, 2d for a pair.
    const rolls = new Set<number>();
    for (const e of p.tokens) {
      if (e < 0 || e > LAST_TRACK) continue;
      for (let d = 1; d <= 6 && e + d <= LAST_TRACK; d++) {
        if (squareOf(p.color, e + d) !== sq) continue;
        rolls.add(d);
        if (d <= 3 && !singles) rolls.add(2 * d);
      }
    }
    for (const d of rolls) {
      for (const m of legalMoves(players, p.color, d, singles)) {
        if (m.captures.some((c) => c.color === color && mine[c.token] === progress)) return true;
      }
    }
  }
  return false;
}

/** A move that takes a threatened token or double to a star or into the home column. */
export function isEscape(players: PlayerState[], move: Move, singles = false): boolean {
  if (move.kind === 'release' || !isThreatened(players, move.color, move.from, singles)) return false;
  if (move.to >= HOME_FIRST) return true;
  const sq = squareOf(move.color, move.to);
  return sq !== null && isSafe(sq);
}

export const isDone = (p: PlayerState) => p.tokens.every((t) => t === FINISHED);
