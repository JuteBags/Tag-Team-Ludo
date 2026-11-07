// The friends hub's logic (#209, a first version), pure and tested (tests/friends.test.ts): friend codes, friends
// both ways, who's online (open connections), and invites into private rooms with their answers. friends.ts is
// the Durable Object around it: its storage is SQLite, its connections are WebSockets.
import { CODE_ALPHABET, FRIEND_CODE_LEN, isCode, isFriendCode, type ErrorCode, type Friend, type FriendClientMsg, type FriendServerMsg } from '../../src/net/protocol';
import { cleanName } from './room-core';

/** What the hub keeps: each account's code and name, and who's friends with whom. */
export interface FriendStore {
  codeOf(id: string): string | null;
  idOfCode(code: string): string | null;
  setCode(id: string, code: string): void;
  nameOf(id: string): string | null;
  setName(id: string, name: string): void;
  friendsOf(id: string): string[];
  link(a: string, b: string): void;
  unlink(a: string, b: string): void;
}

export interface FriendIO {
  send(conn: string, msg: FriendServerMsg): void;
  /** Uniform in [0, 1) (new codes). */
  random(): number;
}

/** The most friends one account keeps (a first version's bound). */
export const MAX_FRIENDS = 100;

export class FriendsCore {
  /** Open connections: conn → account; and each account's connections. */
  private accountOf = new Map<string, string>();
  private conns = new Map<string, Set<string>>();

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
    this.io.send(conn, { t: 'me', code, friends: this.store.friendsOf(id).map((f) => this.friend(f)) });
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
  handle(conn: string, msg: FriendClientMsg): ErrorCode | null {
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
        if (this.store.friendsOf(me).includes(them)) return null;
        if (this.store.friendsOf(me).length >= MAX_FRIENDS || this.store.friendsOf(them).length >= MAX_FRIENDS) return 'full';
        this.store.link(me, them);
        this.toAll(me, { t: 'friend', friend: this.friend(them) });
        this.toAll(them, { t: 'friend', friend: this.friend(me) });
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
