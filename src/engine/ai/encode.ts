// What the value net sees for each colour: the hand features (features.ts) plus a raw block.
// The raw block is the colour's own view: its 4 tokens sorted by progress, each as a progress bucket
// (base, 8 track bins, home column, home) and the distance to the nearest enemy behind and ahead,
// then the same blocks of its enemies pooled (sum and max), so one scorer works for 2, 3 or 4 colours.
import { BASE, FINISHED, HOME_FIRST, LAST_TRACK, TRACK_LEN, squareOf } from '../board';
import type { GameState, PlayerState } from '../types';
import { F, features } from './features';

const BUCKETS = 11;
const PER_TOKEN = BUCKETS + 2;
/** One colour's own block. */
export const RAW = 4 * PER_TOKEN;
/** Numbers per colour: hand features, own block, enemies' blocks summed, enemies' blocks max. */
export const D = F + 3 * RAW;

const bucket = (t: number) => (t === BASE ? 0 : t === FINISHED ? 10 : t >= HOME_FIRST ? 9 : 1 + Math.min(7, Math.floor(t / 6.375)));

/** Nearest enemy within 12 squares behind (`dir` -1) or ahead (+1) of a track square, as (13 - d) / 12. */
function nearest(players: PlayerState[], me: number, sq: number, dir: 1 | -1): number {
  let best = 13;
  for (let j = 0; j < players.length; j++) {
    if (players[j]!.owner === players[me]!.owner) continue;
    for (const e of players[j]!.tokens) {
      const es = squareOf(players[j]!.color, e);
      if (es === null) continue;
      const d = ((dir === 1 ? es - sq : sq - es) + TRACK_LEN) % TRACK_LEN;
      if (d >= 1 && d < best) best = d;
    }
  }
  return best <= 12 ? (13 - best) / 12 : 0;
}

function rawBlock(players: PlayerState[], i: number, out: Float64Array, o: number) {
  const p = players[i]!;
  const sorted = [...p.tokens].sort((a, b) => a - b);
  for (let k = 0; k < RAW; k++) out[o + k] = 0;
  sorted.forEach((t, k) => {
    const b = o + k * PER_TOKEN;
    out[b + bucket(t)] = 1;
    const sq = t >= 0 && t <= LAST_TRACK ? squareOf(p.color, t) : null;
    if (sq !== null) {
      out[b + BUCKETS] = nearest(players, i, sq, -1);
      out[b + BUCKETS + 1] = nearest(players, i, sq, 1);
    }
  });
}

/** players.length * D numbers: each colour's input to the value net, in players order. */
export function encode(players: PlayerState[], current: number, singles: boolean): Float64Array {
  const n = players.length;
  const hand = features(players, current, singles);
  const raw = new Float64Array(n * RAW);
  for (let i = 0; i < n; i++) rawBlock(players, i, raw, i * RAW);
  const out = new Float64Array(n * D);
  for (let i = 0; i < n; i++) {
    const o = i * D;
    for (let k = 0; k < F; k++) out[o + k] = hand[i * F + k]!;
    for (let k = 0; k < RAW; k++) out[o + F + k] = raw[i * RAW + k]!;
    for (let j = 0; j < n; j++) {
      if (players[j]!.owner === players[i]!.owner) continue;
      for (let k = 0; k < RAW; k++) {
        const v = raw[j * RAW + k]!;
        out[o + F + RAW + k]! += v;
        out[o + F + 2 * RAW + k] = Math.max(out[o + F + 2 * RAW + k]!, v);
      }
    }
  }
  return out;
}

export const encodeState = (s: GameState) => encode(s.players, s.current, !!s.singles);
