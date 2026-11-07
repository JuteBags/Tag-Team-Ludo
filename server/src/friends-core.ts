// The friends hub's logic (#209; requests #237), pure and tested (tests/friends.test.ts): friend codes, friend
// requests (accept or decline, never an instant add), friends both ways, who's online (open connections), and
// invites into private rooms with their answers. friends.ts is the Durable Object around it: its storage is SQLite,
// its connections are WebSockets.
//
// A request goes by friend code, or by seat: "whoever played blue in room ABCDE", which the room answers only to
// someone who was in it (index.ts Room.seatAccounts). The app never sees another person's account id: requests
// carry their own random id. Limits: so many requests an hour, so many waiting, and not the same person again
// within a day of the last one.
import type { Color } from '../../src/engine';
import { CODE_ALPHABET, FRIEND_CODE_LEN, isCode, isFriendCode, type ErrorCode, type Friend, type FriendClientMsg, type FriendRequest, type FriendServerMsg, type SeatState } from '../../src/net/protocol';
import { Windows } from './limits';
import { cleanName } from './room-core';

/** A stored request: its id, who sent it, to whom, and when. */
export interface StoredRequest {
  id: string;
  from: string;
  to: string;
  at: number;
}

/** What the hub keeps: each account's code and name, who's friends with whom, and the requests. */
export interface FriendStore {
  codeOf(id: string): string | null;
  idOfCode(code: string): string | null;
  setCode(id: string, code: string): void;
  nameOf(id: string): string | null;
  setName(id: string, name: string): void;
  friendsOf(id: string): string[];
  link(a: string, b: string): void;
  unlink(a: string, b: string): void;
  /** #237: requests. */
  addRequest(r: StoredRequest): void;
  removeRequest(id: string): void;
  requestsTo(id: string): StoredRequest[];
  requestsFrom(id: string): StoredRequest[];
  /** When `from` last asked `to` (kept after an answer, for the day's no-repeat), or null. */
  lastAsked(from: string, to: string): number | null;
  setAsked(from: string, to: string, at: number): void;
}

export interface FriendIO {
  send(conn: string, msg: FriendServerMsg): void;
  /** Uniform in [0, 1) (new codes and request ids). */
  random(): number;
  now(): number;
  /**
   * #237: the account behind each colour in room `room`, asked for by `me`: null when `me` wasn't in that room (or it's
   * gone); a colour's value is null for a bot or a person without an account.
   */
  seatAccounts(room: string, me: string): Promise<Partial<Record<Color, string | null>> | null>;
}

/** The most friends one account keeps (a first version's bound). */
export const MAX_FRIENDS = 100;
/** #237: requests one account may send an hour, may have waiting, and may have waiting for it. */
export const REQUESTS_PER_HOUR = 20;
export const MAX_WAITING_OUT = 30;
export const MAX_WAITING_IN = 100;
/** #237: no new request to the same person within this long of the last one. */
export const REPEAT_MS = 24 * 3_600_000;

export class FriendsCore {
  /** Open connections: conn → account; and each account's connections. */
  private accountOf = new Map<string, string>();
  private conns = new Map<string, Set<string>>();
  /** Requests sent this hour, per account (in memory: lost if the object is evicted, which only forgives). */
  private sent = new Windows(REQUESTS_PER_HOUR);

  constructor(private store: FriendStore, private io: FriendIO) {}

  /** A connection whose account the hub has checked says hello (also after waking: say it again for each). */
  hello(conn: string, id: string, name: string, quiet = false) {
    const clean = cleanName(name);
    if (this.store.nameOf(id) !== clean) this.store.setName(id, clean);
    let code = this.store.codeOf(id);
    if (!code) {
      do code = Array.from({ length: FRIEND_CODE_LEN }, () => CODE_ALPHABET[Math.floor(this.io.random() * CODE_ALPHABET.length)]).join('');
      while (this.store.idOfCode(code));
      this.store.setCode(id, code);
    }
    const wasOnline = this.online(id);
    this.accountOf.set(conn, id);
    if (!this.conns.has(id)) this.conns.set(id, new Set());
    this.conns.get(id)!.add(conn);
    if (quiet) return;
    this.io.send(conn, { t: 'me', code, friends: this.store.friendsOf(id).map((f) => this.friend(f)), requests: this.incoming(id), out: this.store.requestsFrom(id).length });
    if (!wasOnline) this.tellFriends(id);
  }

  /** A connection closed. */
  bye(conn: string) {
    const id = this.accountOf.get(conn);
    if (!id) return;
    this.accountOf.delete(conn);
    const set = this.conns.get(id)!;
    set.delete(conn);
    if (set.size) return;
    this.conns.delete(id);
    this.tellFriends(id);
  }

  /** A message from a connection that said hello. Returns an error for it, or null. */
  async handle(conn: string, msg: FriendClientMsg): Promise<ErrorCode | null> {
    const me = this.accountOf.get(conn);
    if (!me) return 'bad-message';
    switch (msg.t) {
      case 'ping':
        this.io.send(conn, { t: 'pong' });
        return null;
      case 'add': {
        const code = String(msg.code ?? '').toUpperCase();
        const them = isFriendCode(code) ? this.store.idOfCode(code) : null;
        if (!them || them === me) return 'no-friend';
        return this.request(me, them);
      }
      case 'request': {
        if (!isCode(String(msg.room ?? ''))) return 'bad-message';
        const seats = await this.io.seatAccounts(msg.room, me);
        if (!seats) return 'bad-message'; // not a room you were in
        const them = seats[msg.color];
        if (!them) return 'no-account';
        if (them === me) return 'no-friend';
        return this.request(me, them);
      }
      case 'answer': {
        const r = this.store.requestsTo(me).find((x) => x.id === msg.id);
        if (!r) return null; // answered already (another tab), or withdrawn
        this.store.removeRequest(r.id);
        if (msg.accept) this.befriend(me, r.from);
        this.tellRequests(me);
        this.tellRequests(r.from);
        return null;
      }
      case 'room': {
        if (!isCode(String(msg.code ?? ''))) return 'bad-message';
        const seats = await this.io.seatAccounts(msg.code, me);
        if (!seats) return 'bad-message';
        const states: Partial<Record<Color, SeatState>> = {};
        for (const [color, them] of Object.entries(seats) as [Color, string | null][]) if (them !== me) states[color] = this.standing(me, them);
        this.io.send(conn, { t: 'room', code: msg.code, states });
        return null;
      }
      case 'remove': {
        if (!this.store.friendsOf(me).includes(msg.id)) return null;
        this.store.unlink(me, msg.id);
        this.toAll(me, { t: 'friend', friend: this.friend(msg.id), gone: true });
        this.toAll(msg.id, { t: 'friend', friend: this.friend(me), gone: true });
        return null;
      }
      case 'invite':
      case 'reply': {
        if (!this.store.friendsOf(me).includes(msg.to)) return 'not-friends';
        if (!isCode(String(msg.room ?? ''))) return 'bad-message';
        if (!this.online(msg.to)) return 'offline';
        const from = this.friend(me);
        this.toAll(msg.to, msg.t === 'invite' ? { t: 'invite', from, room: msg.room } : { t: 'reply', from, room: msg.room, accept: !!msg.accept });
        return null;
      }
      default:
        return 'bad-message';
    }
  }

  /**
   * `me` asks `them` to be friends. Already friends, or already asked: nothing. They asked me first: that's a yes
   * on both sides. Otherwise the limits, then a new request, which reaches them at once if they're online.
   */
  private request(me: string, them: string): ErrorCode | null {
    if (this.store.friendsOf(me).includes(them)) return null;
    if (this.store.requestsFrom(me).some((r) => r.to === them)) return null;
    const theirs = this.store.requestsTo(me).find((r) => r.from === them);
    if (theirs) {
      this.store.removeRequest(theirs.id);
      this.befriend(me, them);
      this.tellRequests(me);
      this.tellRequests(them);
      return null;
    }
    if (this.store.friendsOf(me).length >= MAX_FRIENDS || this.store.friendsOf(them).length >= MAX_FRIENDS) return 'full';
    const now = this.io.now();
    const last = this.store.lastAsked(me, them);
    if (last !== null && now - last < REPEAT_MS) return 'limit';
    if (this.store.requestsFrom(me).length >= MAX_WAITING_OUT || this.store.requestsTo(them).length >= MAX_WAITING_IN) return 'limit';
    if (!this.sent.hit(me, now)) return 'limit';
    const r: StoredRequest = { id: this.newId(), from: me, to: them, at: now };
    this.store.addRequest(r);
    this.store.setAsked(me, them, now);
    this.toAll(them, { t: 'request', from: { id: r.id, name: this.store.nameOf(me) ?? 'Player', at: now } });
    this.tellRequests(them);
    this.tellRequests(me);
    return null;
  }

  private befriend(a: string, b: string) {
    if (this.store.friendsOf(a).includes(b)) return;
    this.store.link(a, b);
    this.toAll(a, { t: 'friend', friend: this.friend(b) });
    this.toAll(b, { t: 'friend', friend: this.friend(a) });
  }

  /** Where `me` stands with account `them` (null: no account, or a bot). */
  private standing(me: string, them: string | null): SeatState {
    if (!them) return 'unavailable';
    if (this.store.friendsOf(me).includes(them)) return 'friend';
    if (this.store.requestsFrom(me).some((r) => r.to === them)) return 'requested';
    if (this.store.requestsTo(me).some((r) => r.from === them)) return 'incoming';
    return 'none';
  }

  private newId = () => Array.from({ length: 16 }, () => Math.floor(this.io.random() * 16).toString(16)).join('');
  /** The requests to `id`, newest first, as the app sees them. */
  private incoming = (id: string): FriendRequest[] =>
    this.store
      .requestsTo(id)
      .sort((a, b) => b.at - a.at)
      .map((r) => ({ id: r.id, name: this.store.nameOf(r.from) ?? 'Player', at: r.at }));
  private tellRequests(id: string) {
    this.toAll(id, { t: 'requests', requests: this.incoming(id), out: this.store.requestsFrom(id).length });
  }
  private online = (id: string) => (this.conns.get(id)?.size ?? 0) > 0;
  private friend = (id: string): Friend => ({ id, name: this.store.nameOf(id) ?? 'Player', online: this.online(id) });
  private toAll(id: string, msg: FriendServerMsg) {
    for (const c of this.conns.get(id) ?? []) this.io.send(c, msg);
  }
  /** Each online friend of `id` hears whether `id` is online now. */
  private tellFriends(id: string) {
    const me = this.friend(id);
    for (const f of this.store.friendsOf(id)) this.toAll(f, { t: 'friend', friend: me });
  }
}
