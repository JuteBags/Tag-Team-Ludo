// Features of a position, one vector per colour, for the learned value (value.ts). Plain measures, so
// the rules for the easier levels can be read off them later. Danger and threats are counted with fair
// dice (each face 1 in 6): the engine is never told how the game's dice are made.
import { BASE, FINISHED, HOME_FIRST, LAST_TRACK, TRACK_LEN, isSafe, squareOf } from '../board';
import type { GameState, PlayerState } from '../types';

export const FEATURES = [
  'pipsLeft', 'base', 'home', 'column', 'danger', 'dangerProg', 'prey', 'preyProg', 'safe',
  'blocks', 'blocking', 'ambush', 'maxProg', 'minProg', 'turn0', 'turn1', 'turn2', 'turn3', 'singles',
] as const;
export const F = FEATURES.length;

/** Chance a single enemy token `gap` squares behind lands on you next turn, with fair dice. */
const reach = (gap: number) => (gap >= 1 && gap <= 6 ? 1 / 6 : gap >= 7 && gap <= 12 ? 1 / 36 : 0);

/**
 * Features of every colour in `players`, in order, written into `out` (players.length * F numbers).
 * `current` is the index of the colour about to act; turn order is the order of `players`.
 */
export function features(players: PlayerState[], current: number, singles: boolean, out: Float64Array = new Float64Array(players.length * F)): Float64Array {
  const n = players.length;
  // Square -> tokens there, per colour index (track squares only).
  const at: number[][] = Array.from({ length: TRACK_LEN }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    const p = players[i]!;
    for (const t of p.tokens) {
      const sq = squareOf(p.color, t);
      if (sq !== null) at[sq]![i]!++;
    }
  }
  const isDouble = (sq: number, i: number) => !singles && !isSafe(sq) && at[sq]![i]! >= 2 && at[sq]![i]! % 2 === 0;

  for (let i = 0; i < n; i++) {
    const p = players[i]!;
    const o = i * F;
    for (let k = 0; k < F; k++) out[o + k] = 0;
    let pips = 0, maxP = 0, minP = FINISHED, live = 0;
    for (const t of p.tokens) {
      pips += FINISHED - Math.max(t, BASE);
      if (t === BASE) out[o + 1]! += 0.25;
      else if (t === FINISHED) out[o + 2]! += 0.25;
      else if (t >= HOME_FIRST) out[o + 3]! += 0.25;
      if (t !== FINISHED) {
        live++;
        maxP = Math.max(maxP, t + 1);
        minP = Math.min(minP, t + 1);
      }
    }
    out[o] = pips / (4 * (FINISHED + 1));
    out[o + 12] = maxP / FINISHED;
    out[o + 13] = live ? minP / FINISHED : 1;

    const seen = new Set<number>();
    for (const t of p.tokens) {
      const sq = squareOf(p.color, t);
      if (sq === null || seen.has(sq)) continue;
      seen.add(sq);
      const mine = at[sq]![i]!;
      if (isSafe(sq)) {
        out[o + 8]! += mine / 4;
        // Ambush: waiting on a star with enemies behind that still have to pass.
        let behind = false;
        for (let j = 0; j < n && !behind; j++) {
          if (j === i || players[j]!.owner === p.owner) continue;
          for (const e of players[j]!.tokens) {
            const es = squareOf(players[j]!.color, e);
            if (es === null) continue;
            const gap = (sq - es + TRACK_LEN) % TRACK_LEN;
            if (gap >= 1 && gap <= 12 && e + gap <= LAST_TRACK) behind = true;
          }
        }
        if (behind) out[o + 11]! += mine / 4;
        continue;
      }
      const dbl = isDouble(sq, i);
      if (dbl) out[o + 9]! += mine / 4;
      // Danger: the chance some enemy hits this square next turn (a double only falls to a double).
      let safeP = 1;
      for (let j = 0; j < n; j++) {
        if (j === i || players[j]!.owner === p.owner) continue;
        const q = players[j]!;
        const counted = new Set<number>();
        for (const e of q.tokens) {
          const es = squareOf(q.color, e);
          if (es === null || counted.has(es)) continue;
          counted.add(es);
          const gap = (sq - es + TRACK_LEN) % TRACK_LEN;
          if (e + gap > LAST_TRACK) continue; // it turns into its home column first
          if (dbl) {
            if (isDouble(es, j) && gap >= 1 && gap <= 3) safeP *= 5 / 6;
          } else {
            safeP *= 1 - reach(gap);
          }
          if (dbl && gap >= 1 && gap <= 6) out[o + 10]! += at[es]![j]! / 4;
        }
      }
      const hit = 1 - safeP;
      out[o + 4]! += hit * (mine / 4);
      out[o + 5]! += hit * (mine / 4) * ((t + 1) / FINISHED);
      // Prey: enemy singles this token could hit next turn.
      for (let j = 0; j < n; j++) {
        if (j === i || players[j]!.owner === p.owner) continue;
        const q = players[j]!;
        for (const e of q.tokens) {
          const es = squareOf(q.color, e);
          if (es === null || isSafe(es) || isDouble(es, j)) continue;
          const gap = (es - sq + TRACK_LEN) % TRACK_LEN;
          if (t + gap > LAST_TRACK) continue;
          const r = reach(gap);
          out[o + 6]! += r;
          out[o + 7]! += r * ((e + 1) / FINISHED);
        }
      }
    }
    out[o + 14 + ((i - current + n) % n)] = 1;
    out[o + 18] = singles ? 1 : 0;
  }
  return out;
}

export const stateFeatures = (s: GameState) => features(s.players, s.current, !!s.singles);
