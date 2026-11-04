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
import { createGame, move, ownerRanking, roll, type Seat } from './game';
import { mixSeed, positionKey, seeded } from './rng';
import { BASE, COLORS, FINISHED, LAST_TRACK, START, TRACK_LEN, squareOf, type Color } from './board';
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

// ---------------------------------------------------------------------------------------------------------
// Game notation (#164): a game as readable text, like chess's PGN, to paste or share as a tiny file. Every pawn
// has its own letter and every move says where it lands, so a reader can follow each pawn. The spec is
// docs/NOTATION.md; tools/notation.ts reads it back into a record (for us: the app has no import).

/** The colours' letters and names in the notation. */
export const NOTATION_LETTER: Record<Color, string> = { blue: 'B', green: 'G', red: 'R', yellow: 'Y' };
export const NOTATION_NAME: Record<Color, string> = { blue: 'Blue', green: 'Green', red: 'Red', yellow: 'Yellow' };
/** Each colour's four pawns, by token index: fixed, so every game names them the same. */
export const PAWN_LETTERS: Record<Color, string> = { blue: 'abcd', green: 'ghij', red: 'mnop', yellow: 'stuv' };
export const LEVEL_NAME: Record<string, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard', extreme: 'Extreme' };
/** A position line every this many rounds, so a reader can pick the game up anywhere. */
export const SNAPSHOT_EVERY = 20;

/** The line under the header that reads the moves for anyone pasted a game. */
export const NOTATION_LEGEND =
  '; pawns: Blue abcd Green ghij Red mnop Yellow stuv · s+5 G3: pawn s plays 5, lands on G3 · s Y1: out · st+4: pair · squares: arm colour + 1-13 from its start, GH1-5 home column, # home · x captures · | bonus roll · [5] unused · 6 6 6✕ cancelled';

/** The arms in board order: each arm is named by the colour whose start is its first square. */
const ARMS = [...COLORS].sort((a, b) => START[a] - START[b]);

/** A square's board-wide name for `color`'s pawn at `progress`: `G3`, `BH2` (home column), `#` (home), `base`. */
export function squareName(color: Color, progress: number): string {
  if (progress < 0) return 'base';
  if (progress >= FINISHED) return '#';
  if (progress > LAST_TRACK) return `${NOTATION_LETTER[color]}H${progress - LAST_TRACK}`;
  const q = squareOf(color, progress)!;
  const arm = ARMS.find((c) => (q - START[c] + TRACK_LEN) % TRACK_LEN < 13)!;
  return `${NOTATION_LETTER[arm]}${((q - START[arm] + TRACK_LEN) % TRACK_LEN) + 1}`;
}

const pawnOf = (c: Color, token: number) => PAWN_LETTERS[c][token]!;

/** One move: its pawn(s), `+die` (none for a pawn out of base: that's the 6), where it lands, `x` what it captures. */
export function moveNotation(m: Move): string {
  const p = m.tokens.map((k) => pawnOf(m.color, k)).sort().join('');
  const s = m.kind === 'release' ? `${p} ${squareName(m.color, m.to)}` : `${p}+${m.roll} ${squareName(m.color, m.to)}`;
  return m.captures.length ? `${s} x${m.captures.map((c) => pawnOf(c.color, c.token)).sort().join('')}` : s;
}

/** Where every pawn out of base stands: `; after 20: aG1 bB7 c# (others in base)`. */
function snapshot(s: GameState, round: number): string {
  const out = s.players.flatMap((p) => p.tokens.flatMap((t, k) => (t === BASE ? [] : [`${pawnOf(p.color, k)}${squareName(p.color, t)}`])));
  return `; after ${round}: ${out.join(' ')} (others in base)`;
}

/** What the header needs beyond the record: the app's version, the day, and the names by owner. */
export interface NotationInfo {
  app: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Each person's name by owner index (a shared game: replay.ts forSharing's names). */
  names: string[];
  /** The review's accuracy by owner index (0-1), when the game was reviewed. */
  accuracy?: (number | undefined)[];
}

const quote = (v: string) => '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/**
 * The game as notation (docs/NOTATION.md): the header tags, the legend, then a numbered line per round of
 * turns, with a position line every SNAPSHOT_EVERY rounds. Null if the record doesn't replay.
 */
export function toNotation(r: GameRecord, info: NotationInfo): string | null {
  const rep = replay(r);
  if (!rep.ok) return null;
  const states = rep.states;
  const owners = [...new Set(r.seats.map((x) => x.owner))].sort((a, b) => a - b);
  const name = (o: number) => info.names[o] || NOTATION_NAME[r.seats.find((x) => x.owner === o)!.color];
  // The colour tags in owner order (then colour order): reading them back numbers the owners the same.
  const seats = [...r.seats].sort((a, b) => a.owner - b.owner || COLORS.indexOf(a.color) - COLORS.indexOf(b.color));
  const who = (x: Seat) => (x.bot ? `${name(x.owner)} (Bot${x.level ? ' ' + LEVEL_NAME[x.level] : ''})` : name(x.owner));
  const mode = r.meta?.mode === 'pvp' ? 'With friends' : r.meta?.mode === 'pvc' ? 'vs Computer' : null;
  const places = ownerRanking(states[states.length - 1]!).map(name).join(', ');
  const twoHouses = owners.some((o) => r.seats.filter((x) => x.owner === o).length > 1);
  const head = [
    '[Game "Tag Team Ludo"]',
    `[App ${quote(info.app)}]`,
    `[Date ${quote(info.date)}]`,
    ...(mode ? [`[Mode "${mode}"]`] : []),
    ...seats.map((x) => `[${NOTATION_NAME[x.color]} ${quote(who(x))}]`),
    ...(twoHouses ? [`[Sides ${quote(owners.map((o) => `${name(o)}: ${seats.filter((x) => x.owner === o).map((x) => NOTATION_NAME[x.color]).join(', ')}`).join('; '))}]`] : []),
    `[First "${NOTATION_NAME[r.first]}"]`,
    `[Doubles "${r.singles ? 'Off' : 'On'}"]`,
    ...(r.seed !== undefined ? [`[Seed "${r.seed}"]`] : []),
    `[Result ${quote(rep.stopped ? `${places} (stopped)` : places)}]`,
  ];
  const acc = owners.flatMap((o) => (info.accuracy?.[o] !== undefined ? [`${name(o)} ${Math.round(100 * info.accuracy[o]!)}%`] : []));
  if (acc.length) head.push(`[Accuracy ${quote(acc.join(', '))}]`);
  const undos = (r.meta?.undos ?? {}) as Record<string, number>;
  const used = owners.flatMap((o) => (undos[o] ? [`${name(o)} ${undos[o]}`] : []));
  if (used.length) head.push(`[Undos ${quote(used.join(', '))}]`);

  // The turns: the colour, the dice as rolled, `:` and the moves; ` |` a bonus roll and its moves.
  const turns: { seat: number; text: string; start: GameState }[] = [];
  let text = '';
  let dice: string[] = [];
  let moved = false;
  let seat = -1;
  let turnNo = -1;
  let start = states[0]!;
  const close = () => {
    // Dice of a part where nothing was played are unused, in brackets; a cancelled run of 6s is just shown.
    if (dice.length && !moved) text += dice[dice.length - 1]!.endsWith('✕') ? ' ' + dice.join(' ') : ` [${dice.join(' ')}]`;
    dice = [];
  };
  // Events and states go together: states[i + 1] is the position after the event at `at` (a die is one
  // character, a move two). The move comes from the record, since the game's last move reports game-over.
  let at = 0;
  for (let i = 0; i + 1 < states.length; i++) {
    const s = states[i]!;
    const next = states[i + 1]!;
    if (s.phase === 'roll') {
      at++;
      if (s.turnCount !== turnNo || s.current !== seat) {
        close();
        if (text) turns.push({ seat, text, start });
        turnNo = s.turnCount;
        seat = s.current;
        start = s;
        text = NOTATION_LETTER[s.players[s.current]!.color];
        moved = false;
      } else if (moved) {
        text += ' |';
        moved = false;
      }
      dice.push(next.event?.type === 'three-sixes' ? '6✕' : String(next.dice));
    } else {
      const code = r.events.slice(at, at + 2);
      at += 2;
      const m = s.moves.find((x) => moveEvent(x) === code)!;
      if (!moved) {
        text += ` ${dice.join(' ')}:`;
        dice = [];
        moved = true;
      }
      text += ' ' + moveNotation(m);
      const e = next.event;
      if (e?.type === 'moved' && e.lost.length) text += ` [${e.lost.join(' ')}]`;
    }
  }
  close();
  if (text) turns.push({ seat, text, start });
  // A line per round: a new one each time play comes back round (the same or an earlier seat than the last turn).
  const lines: string[] = [];
  let round = 0;
  let prev = Infinity;
  for (const t of turns) {
    if (t.seat <= prev) {
      if (round > 0 && round % SNAPSHOT_EVERY === 0) lines.push(snapshot(t.start, round));
      round++;
      lines.push(`${round}. ${t.text}`);
    } else lines[lines.length - 1] += `  ${t.text}`;
    prev = t.seat;
  }
  return [...head, NOTATION_LEGEND, '', ...lines, ''].join('\n');
}
