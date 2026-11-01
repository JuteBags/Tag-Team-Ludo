// The game record (#65): a game as its setup plus every die and every move, small enough to share in a link.
// Replaying it gives exactly the game that was played, without the bots: dice are stored as rolled, and a
// move is stored by what it does (which token or pair, with which die), so a record doesn't depend on the
// order the engine lists moves in.
//
// Events are one string of characters. Whether the next one is a die or a move follows from the phase the
// replay is in:
//   roll phase: the die, '1'..'6';
//   move phase: two characters, the token(s) then the die. A single token is 'a'..'d' (token 0..3); a pair
//   is 'e'..'j' (tokens 01, 02, 03, 12, 13, 23).
// 'x' as the last event, in any phase: the game ended before its last place was played out (a vote to stop,
// no people left, or the person vs Computer finished), with the places as they stood: ownerRanking of the
// last position, as the result screen does.
import { createGame, move, roll, type Seat } from './game';
import { mixSeed, positionKey, seeded } from './rng';
import { COLORS, type Color } from './board';
import type { GameState, Move } from './types';

export interface GameRecord {
  v: 1;
  /** Who played which colour, the colour that went first, and whether doubles were off. */
  seats: Seat[];
  first: Color;
  singles?: boolean;
  /** The game's dice seed (gameScreen.ts), when every roll came from it: replays can check the dice. */
  seed?: number;
  /** Anything else to keep with the game (the UI stores the mode and the names). */
  meta?: Record<string, unknown>;
  events: string;
}

const PAIRS = ['01', '02', '03', '12', '13', '23'];

const tokensCode = (tokens: number[]) =>
  tokens.length === 1 ? 'abcd'[tokens[0]!]! : 'efghij'[PAIRS.indexOf([...tokens].sort().join(''))]!;

/** One move: its token(s) and its die. */
export function moveEvent(m: Move): string {
  const code = tokensCode(m.tokens);
  if (!code || m.roll < 1 || m.roll > 6) throw new Error('move cannot be recorded');
  return code + m.roll;
}

/** One die, as rolled. */
export const rollEvent = (face: number) => String(face);

/** The game ended early here (only as the last event). */
export const STOP_EVENT = 'x';

const LEVELS = ['easy', 'normal', 'hard', 'extreme'];

/**
 * Why a record's setup can't be a game, or null when it can: 2-4 seats of different colours, owners 0..n-1
 * with none skipped, the first colour among them, and every field of the right kind. A record from a link
 * is untrusted, and createGame takes its seats as they are.
 */
export function setupError(r: GameRecord): string | null {
  const seats: unknown = r?.seats;
  if (!Array.isArray(seats) || seats.length < 2 || seats.length > 4) return 'needs 2 to 4 seats';
  const colors = new Set<string>();
  const owners = new Set<number>();
  for (const s of seats as Partial<Seat>[]) {
    if (!s || typeof s !== 'object') return 'a seat is not an object';
    if (!COLORS.includes(s.color as Color) || colors.has(s.color!)) return 'a seat colour is unknown or used twice';
    colors.add(s.color!);
    if (!Number.isInteger(s.owner) || s.owner! < 0 || s.owner! > 3) return 'a seat owner is out of range';
    owners.add(s.owner!);
    if (typeof s.bot !== 'boolean') return 'a seat does not say if it is a bot';
    if (s.level !== undefined && !LEVELS.includes(s.level)) return 'a bot level is unknown';
  }
  if ([...owners].sort((a, b) => a - b).some((o, i) => o !== i)) return 'the owners skip a number';
  if (!colors.has(r.first)) return 'the first colour is not in the game';
  if (r.singles !== undefined && typeof r.singles !== 'boolean') return 'singles is not true or false';
  if (r.seed !== undefined && !(Number.isInteger(r.seed) && r.seed >= 0 && r.seed <= 0xffffffff)) return 'the seed is not a 32-bit number';
  if (r.meta !== undefined && (typeof r.meta !== 'object' || r.meta === null || Array.isArray(r.meta))) return 'meta is not an object';
  if (typeof r.events !== 'string') return 'events are not text';
  return null;
}

/** The game's first position. */
export const startOf = (r: Pick<GameRecord, 'seats' | 'first' | 'singles'>) => createGame(r.seats, r.first, r.singles);

/** The dice the app rolls at `s` for a game with this seed (gameScreen.ts rngFor('dice')). */
export const seededDie = (seed: number, s: GameState) => roll(s, seeded(mixSeed(seed, 'dice' + positionKey(s)))).dice!;

/** `stopped`: the game ended early (the last position's ownerRanking is the result). */
export type Replayed = { ok: true; states: GameState[]; stopped: boolean } | { ok: false; error: string; states: GameState[] };

/**
 * Replays the record: the first position, then the position after every event. It stops at the first event
 * that doesn't fit (an unknown version, a die out of range, a move that isn't legal there, or with
 * `checkDice` a die the seed wouldn't have rolled) and says why, keeping the states up to that point.
 */
export function replay(r: GameRecord, opts: { checkDice?: boolean } = {}): Replayed {
  const fail = (error: string, states: GameState[]): Replayed => ({ ok: false, error, states });
  if (r?.v !== 1) return fail(`This game was saved by a different version of the app (record v${String(r?.v)}).`, []);
  const bad = setupError(r);
  if (bad) return fail(`The game setup is damaged (${bad}).`, []);
  let s: GameState;
  try {
    s = startOf(r);
  } catch {
    return fail('The game setup is damaged.', []);
  }
  const states = [s];
  const e = typeof r.events === 'string' ? r.events : '';
  for (let i = 0; i < e.length; i++) {
    if (s.phase === 'over') return fail(`Events after the end of the game (at ${i}).`, states);
    if (e[i] === STOP_EVENT) {
      if (i !== e.length - 1) return fail(`Events after the end of the game (at ${i}).`, states);
      return { ok: true, states, stopped: true };
    }
    try {
      if (s.phase === 'roll') {
        const face = Number(e[i]);
        if (!(face >= 1 && face <= 6)) return fail(`A die that can't be (at ${i}).`, states);
        if (opts.checkDice && r.seed !== undefined && seededDie(r.seed, s) !== face) return fail(`A die that differs from this game's dice (at ${i}).`, states);
        s = roll(s, () => 0, face);
      } else {
        const code = e.slice(i, i + 2);
        const m = s.moves.filter((x) => tokensCode(x.tokens) + x.roll === code);
        if (m.length !== 1) return fail(`A move that isn't legal there (at ${i}).`, states);
        s = move(s, m[0]!);
        i++;
      }
    } catch {
      // Something the checks above let through still broke the engine: a damaged record.
      return fail(`The game is damaged (at ${i}).`, states);
    }
    states.push(s);
  }
  return { ok: true, states, stopped: false };
}

/** The longest share string decoded, and the most JSON it may inflate to (a damaged or hostile link). */
export const MAX_LINK = 16_000;
const MAX_JSON = 200_000;

const b64url = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > limit) {
      await reader.cancel();
      throw new Error('too large');
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The record as a short URL-safe string (deflated JSON, base64url), for a share link. */
export async function encodeRecord(r: GameRecord): Promise<string> {
  return b64url(await pipe(new TextEncoder().encode(JSON.stringify(r)), new CompressionStream('deflate-raw')));
}

/**
 * The record back from `encodeRecord`, or null for anything that isn't a whole, replayable record: too long,
 * not base64url, inflating past the cap, not JSON, or failing to replay. Shared links are untrusted input.
 */
export async function decodeRecord(s: string): Promise<GameRecord | null> {
  if (s.length > MAX_LINK || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const json = new TextDecoder().decode(await pipe(unb64url(s), new DecompressionStream('deflate-raw'), MAX_JSON));
    const r = JSON.parse(json) as GameRecord;
    if (!r || typeof r !== 'object' || !Array.isArray(r.seats) || typeof r.events !== 'string') return null;
    return replay(r).ok ? r : null;
  } catch {
    return null;
  }
}
