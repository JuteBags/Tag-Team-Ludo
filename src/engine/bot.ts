// Single-level heuristic bot: scores each legal move and picks the best.
import { HOME_FIRST, FINISHED, LAST_TRACK, isSafe, squareOf } from './board';
import { move, roll } from './game';
import { applyMove, countAt, isThreatened, playerOf } from './rules';
import type { GameState, Move, Rng } from './types';

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

export function chooseMove(state: GameState, rng: Rng): Move {
  let best: Move | undefined;
  let bestScore = -Infinity;
  for (const m of state.moves) {
    const s = scoreMove(state, m) + rng() * 0.5; // small jitter breaks ties
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
