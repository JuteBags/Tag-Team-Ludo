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
export const PROTOCOL = 1;

/** Room codes: no 0/O or 1/I, so a code read out loud or copied by hand is right. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LEN = 5;
export const isCode = (s: string) => s.length === CODE_LEN && [...s].every((c) => CODE_ALPHABET.includes(c));

/** Longest name a person can have in a room. */
export const MAX_NAME = 16;
/** Online bots: the rule bots only (the server has no Extreme engine). */
export type OnlineBotLevel = Exclude<BotLevel, 'extreme'>;
export const ONLINE_LEVELS: readonly OnlineBotLevel[] = ['easy', 'normal', 'hard'];

/** What the host chose when creating the room. */
export interface RoomOptions {
  /** Houses in the game (2-4); seats no person takes are played by bots. */
  players: 2 | 3 | 4;
  /** Doubles off (RULES.md section I). */
  singles: boolean;
  /** How the bots in empty seats play. */
  botLevel: OnlineBotLevel;
}

/** A person in the room. `owner` is their seat (and their index in a game's names). */
export interface Member {
  owner: number;
  name: string;
  /** Connected right now. */
  online: boolean;
  host: boolean;
  /** A bot plays for them (they left, or let the clock run out too often). */
  auto: boolean;
}

/** A game as the app needs it to start: the record's setup and the people's names (bots have none). */
export interface GameSetup {
  seats: Seat[];
  first: Color;
  singles: boolean;
  /** Names by owner; empty for bots' seats. */
  names: string[];
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
  | { t: 'ping' };

export type ServerMsg =
  /**
   * The room before its game: on joining, and whenever someone comes, goes or the host changes. `endsIn`: ms
   * until the wait ends (the game starts with bots, or the room closes if nobody joined).
   */
  | { t: 'lobby'; code: string; options: RoomOptions; members: Member[]; you: number; endsIn: number }
  /** The whole game so far: when it starts, and on every reconnect. The app replays `events` from `setup`. */
  | { t: 'game'; code: string; setup: GameSetup; events: string[]; members: Member[]; you: number; turn: Turn | null }
  /** One more event, at index `seq`; then whose turn it is. */
  | { t: 'ev'; seq: number; ev: string; turn: Turn | null }
  /** Someone connected, dropped, left, or got a bot playing for them. */
  | { t: 'members'; members: Member[] }
  /**
   * The game is over. `stopped`: it ended before its last place was played out (only bots were left), so
   * the record ends with STOP_EVENT. `seed` is the game's dice seed, revealed now for the review's luck.
   */
  | { t: 'over'; seed: number; stopped: boolean }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'pong' };

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
  | 'bad-message';
