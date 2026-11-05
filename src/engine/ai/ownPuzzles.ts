// "One of yours" (#99): puzzles from a person's own stored reviews, offered after the day's puzzle is solved
// or when the pool can't load. A key verdict (mistake or blunder) from a full review becomes a puzzle when
// its position has one clear best move. The rule is the pool's, with a margin: the stored review keeps every
// move's gap but the standard error of the played move only, which stands in for the rest.
//   2nd-best gap − 2·se ≥ 3·f + 0.5, and se ≤ 1.5 (f: the layout's scale, THRESHOLDS_BY_LAYOUT)
// Moves with a gap of 0 must reach the best's position (the same candidate), or it's a tie: no puzzle. The
// reveal's line is the real game: the played move and what followed, to the end of the mover's next turn.
import { move, moveEvent, positionKey, replay, seeded, type GameRecord, type GameState } from '..';
import type { Puzzle } from '../puzzles';
import { chooseBotMove } from './levels';
import { layoutKey, REVIEW_VERSION, THRESHOLDS_BY_LAYOUT, type MoveReview } from './review';

/** The played move's standard error above which the stand-in is too loose. */
export const OWN_MAX_SE = 1.5;
/** The margin over the pool's rule, for that stand-in. */
export const OWN_MARGIN = 0.5;

/** One of the person's puzzles: a pool puzzle's fields, from a game of theirs. */
export interface OwnPuzzle extends Omit<Puzzle, 'line' | 'wrong' | 'layout'> {
  /** Unique per game and decision (the caller's game id, then the decision's index in the replay). */
  id: string;
  layout: string;
  /** The move they played (a mistake or blunder) and the real game from there. */
  played: { move: number; events: string };
}

/** A game of theirs with its review: `id` names the game (the store's key), `v` the review's version. */
export interface ReviewedGame {
  id: string;
  rec: GameRecord;
  v: number;
  moves: MoveReview[];
}

/** The events of `rec` from the decision at `at` (its move first) to the end of the mover's next turn. */
function followed(rec: GameRecord, states: GameState[], at: number): string {
  // states[k + 1] is the position after event k; a move takes two characters. Find each state's event offset.
  const offsets: number[] = [];
  let i = 0;
  for (let k = 0; k + 1 < states.length; k++) {
    offsets.push(i);
    i += states[k]!.phase === 'move' ? 2 : 1;
  }
  const mover = states[at]!.current;
  let stage = 0;
  let end = states.length - 1;
  for (let k = at + 1; k < states.length; k++) {
    const s = states[k]!;
    if (stage === 0 && s.current !== mover) stage = 1;
    if (stage === 1 && s.current === mover) stage = 2;
    if ((stage === 2 && s.current !== mover) || s.phase === 'over') {
      end = k;
      break;
    }
  }
  return rec.events.slice(offsets[at], end < offsets.length ? offsets[end] : rec.events.length).replace('x', '');
}

/** The band, as the pool's: Hard when the Normal bot misses it, else Easy or Medium by the 2nd-best gap. */
function bandOf(s: GameState, gaps: number[], f: number, seed: number): Puzzle['band'] {
  const players = s.players.map((p, k) => (k === s.current ? { ...p, level: 'normal' as const } : p));
  const m = chooseBotMove({ ...s, players }, seeded(seed));
  const pick = s.moves.findIndex((x) => moveEvent(x) === moveEvent(m));
  const others = gaps.filter((g) => g > 0);
  const plausible = 1 + others.filter((g) => g <= 15 * f).length;
  let band: Puzzle['band'] = gaps[pick]! > 0 ? 'hard' : Math.min(...others) >= 10 * f ? 'easy' : 'medium';
  if (plausible === 1) band = band === 'hard' ? 'medium' : 'easy';
  return band;
}

/**
 * Every puzzle in these reviewed games, biggest mistakes first (then newer games first: `games` newest first).
 * Only full reviews of this version (REVIEW_VERSION) count.
 */
export function ownPuzzles(games: ReviewedGame[]): OwnPuzzle[] {
  const out: (OwnPuzzle & { order: number })[] = [];
  games.forEach((g, gi) => {
    if (g.v !== REVIEW_VERSION) return;
    const r = replay(g.rec);
    if (!r.ok) return;
    for (const m of g.moves) {
      if (m.label !== 'mistake' && m.label !== 'blunder') continue;
      if (m.approx || !m.gaps || m.se > OWN_MAX_SE) continue;
      const s = r.states[m.at];
      if (!s || s.phase !== 'move' || s.moves.length !== m.gaps.length) continue;
      const f = THRESHOLDS_BY_LAYOUT[layoutKey(s)] ?? 1;
      // A 0 gap that isn't the best's position: a tie, not one clear best.
      const bestKey = positionKey(move(s, s.moves[m.best]!));
      if (m.gaps.some((x, i) => x === 0 && i !== m.best && positionKey(move(s, s.moves[i]!)) !== bestKey)) continue;
      const others = m.gaps.filter((x) => x > 0);
      if (!others.length) continue;
      if (Math.min(...others) - 2 * m.se < 3 * f + OWN_MARGIN) continue;
      const best = 100 * m.bestChance;
      out.push({
        id: `${g.id}:${m.at}`,
        band: bandOf(s, m.gaps, f, m.at * 7919 + gi),
        layout: layoutKey(s),
        state: s,
        gaps: m.gaps,
        // The stored review keeps the best's and the played move's chances; the others' follow from their gaps.
        chances: m.gaps.map((x, i) => Math.round(i === m.played ? 100 * m.playedChance : best - x)),
        best: m.best,
        expert: false,
        played: { move: m.played, events: followed(g.rec, r.states, m.at) },
        order: gi,
      });
    }
  });
  return out
    .sort((a, b) => b.gaps[b.played.move]! - a.gaps[a.played.move]! || a.order - b.order)
    .map(({ order: _, ...p }) => p);
}
