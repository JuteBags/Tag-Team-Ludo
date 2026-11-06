// The online protocol (private rooms): the messages between the app and the room server (server/), shared by
// both. JSON over one WebSocket per player. The server owns the game: it rolls every die, checks every move
// and plays the bots; the app sends what its person wants to do and animates what the server confirms.
//
// A game travels as record events (engine/record.ts): a die is '1'..'6', a move is its token(s) and its die
// ('a4', 'e6'). Every event has a sequence number (its index in the game's event list), so the app sees a
// gap at once, and an action names the sequence number it was made at, so a stale tap (a double tap, a turn
// the timer already played) is turned down instead of played twice.
import type { BotLevel, Color, Seat } from '../engine';

/** Bumped on any change the other side can't read: an app and a server with different versions don't play. */
export const PROTOCOL = 3;

/** Room codes: no 0/O or 1/I, so a code read out loud or copied by hand is right. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LEN = 5;
export const isCode = (s: string) => s.length === CODE_LEN && [...s].every((c) => CODE_ALPHABET.includes(c));

/** Longest name a person can have in a room. */
export const MAX_NAME = 16;
/** Online bots: the rule bots only (the server has no Extreme engine). */
export type OnlineBotLevel = Exclude<BotLevel, 'extreme'>;
export const ONLINE_LEVELS: readonly OnlineBotLevel[] = ['easy', 'normal', 'hard'];

/**
 * The four online modes (rooms and ranked):
 *   ffa   1v1v1v1: four sides, one colour each
 *   1v1   two sides, one colour each, in opposite corners
 *   duo   1(x2) v 1(x2): two people, two colours each (opposite or side by side)
 *   2v2   two teams of two people: each person plays one colour, partners sit opposite and are one side
 * In the engine a side is an owner. duo and 2v2 are the same game (two owners, two colours each); only who
 * taps for each colour differs, so 2v2 needs no new rules: teammates never capture or block each other.
 */
export type GameMode = 'ffa' | '1v1' | 'duo' | '2v2';
export const GAME_MODES: readonly GameMode[] = ['ffa', '1v1', 'duo', '2v2'];
export const MODE_LABEL: Record<GameMode, string> = { ffa: '1v1v1v1', '1v1': '1v1', duo: '1(x2) v 1(x2)', '2v2': '2v2' };
export const MODE_NOTE: Record<GameMode, string> = {
  ffa: 'Four players, every one for themselves',
  '1v1': 'Two players, one colour each',
  duo: 'Two players, two colours each',
  '2v2': 'Two teams of two; partners sit opposite',
};
export type Pairing = 'opposite' | 'adjacent';

/** A person's place in a mode: the colours they play and their side (the engine's owner). */
export interface Slot {
  colors: Color[];
  side: number;
}

/** Every person's slot in a mode, in join order (the host takes the first). */
export function modeSlots(mode: GameMode, pairing: Pairing = 'opposite'): Slot[] {
  switch (mode) {
    case 'ffa':
      return (['blue', 'green', 'red', 'yellow'] as const).map((c, side) => ({ colors: [c], side }));
    case '1v1':
      return [{ colors: ['blue'], side: 0 }, { colors: ['red'], side: 1 }];
    case 'duo':
      return pairing === 'opposite'
        ? [{ colors: ['blue', 'red'], side: 0 }, { colors: ['green', 'yellow'], side: 1 }]
        : [{ colors: ['blue', 'yellow'], side: 0 }, { colors: ['green', 'red'], side: 1 }];
    case '2v2':
      return [{ colors: ['blue'], side: 0 }, { colors: ['green'], side: 1 }, { colors: ['red'], side: 0 }, { colors: ['yellow'], side: 1 }];
  }
}

/** What the host chose when creating the room. */
export interface RoomOptions {
  mode: GameMode;
  /** duo only: a person's two colours are opposite or side by side. */
  pairing: Pairing;
  /** Doubles off (RULES.md section I). */
  singles: boolean;
  /** How the bots in empty slots play. */
  botLevel: OnlineBotLevel;
}

/** A person in the room. `owner` is their slot (modeSlots order), not the engine's owner: see GameSetup.control. */
export interface Member {
  owner: number;
  name: string;
  /** Connected right now. */
  online: boolean;
  host: boolean;
  /** Left the game (they forfeited: Leave game, gone too long, or too many timeouts). */
  left: boolean;
}

/** A game as the app needs it to start: the record's setup, who plays each colour, and names. */
export interface GameSetup {
  mode: GameMode;
  seats: Seat[];
  first: Color;
  singles: boolean;
  /** Names by side (the engine's owner): a person's name, "A & B" for a team, empty for a side of bots. */
  names: string[];
  /** The member (slot) who plays each colour; -1 for a bot. */
  control: Partial<Record<Color, number>>;
  /** Each member's name, by member index. */
  people: string[];
  /** A ranked game: it rates everyone at the end (a `rated` message). */
  ranked?: boolean;
}

/** Whose action the server waits for, and for how long. `ms` is null for a bot (the server plays it). */
export interface Turn {
  color: Color;
  ms: number | null;
}

export type ClientMsg =
  /** First on every connection: who this is. `token` is the device's secret id for this room, kept across reconnects. */
  | { t: 'hello'; protocol: number; token: string; name: string }
  /** The host starts the game (bots take the empty seats). */
  | { t: 'start' }
  /** Roll for the current colour, at event `seq`. */
  | { t: 'roll'; seq: number }
  /** Play this move (a record move event) at event `seq`. */
  | { t: 'move'; seq: number; ev: string }
  /** Leave the room: from the lobby the seat frees up; in a game a bot plays on for you. */
  | { t: 'leave' }
  /** Chat (#212): one of QUICK_CHAT, one of CHAT_EMOJI, or free text (private rooms only). */
  | { t: 'chat'; quick?: number; emoji?: number; text?: string }
  /** Report a chat line: who said it (member index) and what it said. The server keeps nothing else. */
  | { t: 'report'; from: number; text: string }
  | { t: 'ping' };

export type ServerMsg =
  /**
   * The room before its game: on joining, and whenever someone comes, goes or the host changes. `endsIn`: ms
   * until the wait ends (the game starts with bots, or the room closes if nobody joined).
   */
  | { t: 'lobby'; code: string; options: RoomOptions; members: Member[]; you: number; endsIn: number; chat?: ChatFeatures }
  /** The whole game so far: when it starts, and on every reconnect. The app replays `events` from `setup`. */
  | { t: 'game'; code: string; setup: GameSetup; events: string[]; members: Member[]; you: number; turn: Turn | null; chat?: ChatFeatures }
  /** One more event, at index `seq`; then whose turn it is. */
  | { t: 'ev'; seq: number; ev: string; turn: Turn | null }
  /** Someone connected, dropped, left, or got a bot playing for them. */
  | { t: 'members'; members: Member[] }
  /**
   * The game is over. `stopped`: it ended before its last place was played out (only bots were left), so
   * the record ends with STOP_EVENT. `seed` is the game's dice seed, revealed now for the review's luck.
   */
  | { t: 'over'; seed: number; stopped: boolean }
  /** Ranked: this person's rating in the game's mode, before and after the game (sent after `over`). */
  | { t: 'rated'; mode: GameMode; before: number; after: number; games: number }
  /** A chat line from member `from` (relayed as it came, after the server's clean-up; stored nowhere). */
  | { t: 'chat'; from: number; quick?: number; emoji?: number; text?: string; at: number }
  /** The report reached the server. */
  | { t: 'reported' }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'pong' };

// ---------- ranked: accounts and the queue ----------

/** A guest account: `secret` proves it's yours (only its hash is kept on the server). */
export interface AccountKey {
  id: string;
  secret: string;
}

/** One mode's rating for a person. */
export interface ModeRating {
  rating: number;
  games: number;
  wins: number;
}

/**
 * POST /api/account {id?, secret?, name}: the account, made on the first call (without id and secret), with
 * the name updated. The answer: the key and every mode's rating.
 */
export interface AccountReply {
  id: string;
  secret: string;
  name: string;
  ratings: Record<GameMode, ModeRating>;
}

/** The queue, on GET /mm?mode=<mode> (a WebSocket): the first message, then the server's. */
export type QueueClientMsg = { t: 'queue'; protocol: number; account: AccountKey; name: string } | { t: 'leave' };

export type QueueServerMsg =
  /** In the queue: your rating, how long you've waited, the rating gap allowed now, and how many are searching. */
  | { t: 'search'; rating: number; waited: number; window: number; searching: number; botsAt: number }
  /** A game: join room `code` with `token` (a RoomLink); it has already started. */
  | { t: 'matched'; code: string; token: string; mode: GameMode }
  | { t: 'error'; code: ErrorCode; message: string };

export type ErrorCode =
  | 'protocol' // the app is older or newer than the server
  | 'no-room' // no room with that code
  | 'full'
  | 'started' // the game started without you
  | 'expired' // the lobby's wait ended with nobody but the host
  | 'not-host'
  | 'not-enough' // the host can't start alone
  | 'not-your-turn'
  | 'stale' // the action was made at an older event
  | 'illegal'
  | 'no-account' // the ranked account is unknown or its secret is wrong
  | 'in-queue' // this account is already searching
  | 'bad-message';

// ---------- chat (#212) ----------
// Quick phrases and emoji for everyone; free text in private rooms only. The server relays each line to the room
// and stores none; a report sends that one line and the room's code to the server's log. A server without chat
// (an older one) doesn't announce it, and the app shows no chat.

/** What a room's chat allows (announced in `lobby` and `game`). */
export interface ChatFeatures {
  text: boolean;
}
export const QUICK_CHAT: readonly string[] = ['Nice move!', 'Your turn', 'Good luck!', 'So close!', 'Oops!', 'Thanks!', 'Well played', 'GG'];
export const CHAT_EMOJI: readonly string[] = ['👍', '👏', '😂', '😮', '😢', '😡', '🎉', '🔥'];
/** Longest free-text line, and the least time between two lines from one person. */
export const CHAT_MAX = 120;
export const CHAT_GAP_MS = 1000;

/** Words the filter masks (whole words, any case): a short list, to grow from reports. */
const BLOCKED = ['fuck', 'fucking', 'shit', 'bitch', 'bastard', 'asshole', 'cunt', 'dick', 'slut', 'whore', 'chutiya', 'madarchod', 'bhenchod', 'behenchod', 'gandu', 'randi'];
const BLOCKED_RE = new RegExp(`\\b(${BLOCKED.join('|')})\\b`, 'gi');

/** A free-text line as the room sees it: no control characters, spaces collapsed, CHAT_MAX at most, rude words masked. Empty: not sent. */
export function cleanChat(text: unknown): string {
  if (typeof text !== 'string') return '';
  const t = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
  return t.replace(BLOCKED_RE, (w) => w[0] + '*'.repeat(w.length - 1));
}
