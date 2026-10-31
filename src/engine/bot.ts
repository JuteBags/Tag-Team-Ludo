// Heuristic bots: score each legal move and pick the best, at three levels (see chooseMove).
import { HOME_FIRST, FINISHED, LAST_TRACK, TRACK_LEN, isSafe, squareOf, type Color } from './board';
import { move, roll } from './game';
import { applyMove, countAt, isThreatened, playerOf, sameSide } from './rules';
import type { GameState, Move, PlayerState, Rng } from './types';

export function scoreMove(state: GameState, m: Move): number {
  const { players } = state;
  const after = applyMove(players, m);
  const onTrack = m.to <= LAST_TRACK;
  const toSq = squareOf(m.color, m.to);
  let s = 0;

  for (const c of m.captures) s += 100 + playerOf(players, c.color).tokens[c.token]!;
  s += 80 * m.finishes;
  if (m.kind === 'release') s += 45;
  if (m.from < HOME_FIRST && m.to >= HOME_FIRST && m.to < FINISHED) s += 50;

  const wasThreatened = m.kind !== 'release' && isThreatened(players, m.color, m.from);
  const nowThreatened = onTrack && isThreatened(after, m.color, m.to);
  if (wasThreatened && !nowThreatened) s += 60;
  if (nowThreatened) s -= 50 + m.to * 0.8; // losing an advanced token hurts more

  if (toSq !== null && isSafe(toSq)) s += 15;
  if (toSq !== null && !isSafe(toSq) && countAt(after, m.color, toSq) >= 2) s += 35; // forms or keeps a block

  // Breaking a block can leave the token behind exposed.
  const fromSq = squareOf(m.color, m.from);
  if (m.kind === 'single' && fromSq !== null && !isSafe(fromSq) && countAt(players, m.color, fromSq) >= 2) {
    s -= 25;
    if (isThreatened(after, m.color, m.from)) s -= 30;
  }

  s += m.steps * m.tokens.length * 0.6;
  return s;
}

// ---------- levels ----------
// Normal is scoreMove above. Easy often plays any legal move and ignores danger. Hard adds what
// Normal misses: danger to all its tokens (not only the one that moved), when a double on a normal
// square is worth locking up, and lining up kills for its next turn.

/** Easy: Normal's wish list without any sense of danger. */
function scoreEasy(state: GameState, m: Move): number {
  let s = 0;
  for (const c of m.captures) s += 100;
  s += 80 * m.finishes;
  if (m.kind === 'release') s += 45;
  return s + m.steps * m.tokens.length * 0.6;
}

/** Value at risk: each token of `color` an enemy could hit next turn, worth more the further it has got. */
function exposure(players: PlayerState[], color: Color): number {
  let risk = 0;
  const seen = new Set<number>();
  for (const t of playerOf(players, color).tokens) {
    if (t < 0 || t > LAST_TRACK || seen.has(t)) continue;
    seen.add(t);
    if (isThreatened(players, color, t)) risk += (20 + t * 1.4) * countAt(players, color, squareOf(color, t)!);
  }
  return risk;
}

/** Enemy singles that `color`'s token at `progress` could hit with one roll next turn, by their progress. */
function prey(players: PlayerState[], color: Color, progress: number): number {
  const from = squareOf(color, progress);
  if (from === null) return 0;
  let value = 0;
  for (const p of players) {
    if (sameSide(players, p.color, color)) continue;
    for (const e of p.tokens) {
      const sq = squareOf(p.color, e);
      if (sq === null || isSafe(sq) || countAt(players, p.color, sq) > 1) continue;
      const gap = (sq - from + TRACK_LEN) % TRACK_LEN;
      if (gap >= 1 && gap <= 6 && progress + gap <= LAST_TRACK) value += 10 + e * 0.3;
    }
  }
  return value;
}

/** Is an enemy single within six squares behind `square`, so a double there blocks it? */
function blocksSomeone(players: PlayerState[], color: Color, square: number): boolean {
  return players.some((p) => !sameSide(players, p.color, color) && p.tokens.some((e) => {
    const sq = squareOf(p.color, e);
    if (sq === null) return false;
    const gap = (square - sq + TRACK_LEN) % TRACK_LEN;
    return gap >= 1 && gap <= 6;
  }));
}

/** Hard: Normal's score, corrected for whole-board danger, locked doubles and next-turn kills. */
function scoreHard(state: GameState, m: Move): number {
  const { players } = state;
  const after = applyMove(players, m);
  let s = scoreMove(state, m);
  // Danger to every token, not just the one that moved (Normal already counts the mover).
  s -= 0.9 * (exposure(after, m.color) - exposure(players, m.color));
  const toSq = squareOf(m.color, m.to);
  if (toSq !== null && !isSafe(toSq) && countAt(after, m.color, toSq) >= 2 && m.kind !== 'pair') {
    // A double on a normal square is locked: it only moves on even rolls. Worth it to block someone.
    s += blocksSomeone(after, m.color, toSq) ? 10 : -55;
  }
  if (m.to <= LAST_TRACK && m.kind !== 'pair') s += 1.2 * prey(after, m.color, m.to);
  // Few tokens out: getting another one out matters more.
  if (m.kind === 'release' && playerOf(players, m.color).tokens.filter((t) => t >= 0 && t < FINISHED).length <= 1) s += 20;
  return s;
}

export function chooseMove(state: GameState, rng: Rng): Move {
  const level = state.players[state.current]!.level ?? 'normal';
  if (level === 'easy' && state.moves.length > 1 && rng() < 0.45) return state.moves[Math.floor(rng() * state.moves.length)]!;
  const score = level === 'easy' ? scoreEasy : level === 'hard' ? scoreHard : scoreMove;
  let best: Move | undefined;
  let bestScore = -Infinity;
  for (const m of state.moves) {
    const s = score(state, m) + rng() * 0.5; // small jitter breaks ties
    if (s > bestScore) {
      bestScore = s;
      best = m;
    }
  }
  if (!best) throw new Error('no legal moves');
  return best;
}

/** One step for whoever is current: roll, or pick and play a move. */
export function botStep(state: GameState, rng: Rng): GameState {
  if (state.phase === 'roll') return roll(state, rng);
  if (state.phase === 'move') return move(state, chooseMove(state, rng));
  return state;
}
