// Friends (#209, a first version): the app's one WebSocket to the server's friends hub (GET /fr). It says hello with
// this device's guest account (ranked.ts loadAccount: made on first use), then keeps the friend code and the
// friends list (who's online) up to date, and carries invites into private rooms and their answers. It
// reconnects with backoff and pings to stay up. Online play only, so it starts only after the terms (#208).
//
// Friend requests (#237): adding (by code, or by seat after a game) sends a request, which the other person
// accepts or declines. After a game the result screen asks the hub where you stand with each seat (loadRoom), by
// keys from RoomLink.addable: "<room>|<colour>" for a person; "<room>|bot|<colour>" for a ranked bot, which this
// link never sends (it only shows as requested). The app never sees another person's account id.
import { roomsUrl } from './client';
import type { Color } from '../engine';
import { PROTOCOL, type AccountKey, type Friend, type FriendClientMsg, type FriendRequest, type FriendServerMsg, type SeatState } from './protocol';
import { loadAccount, savedKey } from './ranked';

const PING_MS = 20_000;
type Event = FriendServerMsg | { t: 'status' };

export class FriendsLink {
  status: 'connecting' | 'open' | 'retrying' | 'closed' = 'connecting';
  /** This account's friend code (once the hub has said). */
  code = '';
  friends: Friend[] = [];
  /** #237: friend requests to you, newest first; and how many of yours wait for an answer. */
  requests: FriendRequest[] = [];
  out = 0;
  /** #237: where you stand with each seat key (from loadRoom, and this app's own requests). */
  private seats = new Map<string, SeatState>();
  /** The last request sent, to put its seat back if the hub turns it down. */
  private lastSent: { key: string; was: SeatState | undefined } | null = null;
  private ws: WebSocket | null = null;
  private listeners = new Set<(m: Event) => void>();
  private tries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private account: AccountKey, private name: string) {
    this.open();
  }

  on(f: (m: Event) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private emit(m: Event) {
    for (const f of [...this.listeners]) f(m);
  }

  private setStatus(s: FriendsLink['status']) {
    this.status = s;
    this.emit({ t: 'status' });
  }

  private open() {
    const ws = new WebSocket(`${roomsUrl()}/fr`);
    this.ws = ws;
    ws.onopen = () => {
      this.tries = 0;
      this.send({ t: 'hello', protocol: PROTOCOL, account: this.account, name: this.name });
      this.pingTimer = setInterval(() => this.send({ t: 'ping' }), PING_MS);
    };
    ws.onmessage = (e) => {
      let m: FriendServerMsg;
      try {
        m = JSON.parse(String(e.data)) as FriendServerMsg;
      } catch {
        return;
      }
      this.take(m);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.status === 'closed') return;
      this.setStatus('retrying');
      this.retryTimer = setTimeout(() => this.open(), Math.min(30_000, 1000 * 2 ** this.tries++));
    };
  }

  private take(m: FriendServerMsg) {
    // #220: friends opened on another connection (another tab): this one stops instead of taking it back.
    if (m.t === 'error' && m.code === 'replaced') this.close();
    if (m.t === 'me') {
      this.code = m.code;
      this.friends = m.friends;
      this.requests = m.requests ?? [];
      this.out = m.out ?? 0;
      this.setStatus('open');
    } else if (m.t === 'requests') {
      this.requests = m.requests;
      this.out = m.out;
    } else if (m.t === 'room') {
      for (const [color, state] of Object.entries(m.states)) this.seats.set(`${m.code}|${color}`, state);
      this.emit({ t: 'status' });
    } else if (m.t === 'error' && this.lastSent && ['limit', 'no-account', 'full', 'no-friend', 'bad-message'].includes(m.code)) {
      // The last request didn't go: its button goes back.
      const { key, was } = this.lastSent;
      if (was === undefined) this.seats.delete(key);
      else this.seats.set(key, was);
      this.lastSent = null;
      this.emit({ t: 'status' });
    } else if (m.t === 'friend') {
      const rest = this.friends.filter((f) => f.id !== m.friend.id);
      this.friends = m.gone ? rest : [...rest, m.friend];
    }
    this.emit(m);
  }

  private send(m: FriendClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** #238: the name behind friend code `code` (a friend link's prompt); null when no one has it, `self` when it's yours. */
  who(code: string): Promise<{ name: string | null; self: boolean } | null> {
    const c = code.trim().toUpperCase();
    return new Promise((res) => {
      const t = setTimeout(() => (off(), res(null)), 10_000);
      const off = this.on((m) => {
        if (m.t !== 'who' || m.code !== c) return;
        clearTimeout(t);
        off();
        res({ name: m.name, self: !!m.self });
      });
      this.send({ t: 'who', code: c });
    });
  }

  /** A friend request by friend code (#237: no longer an instant add). */
  add(code: string) {
    this.send({ t: 'add', code: code.trim().toUpperCase() });
  }

  // ---------- after a game (#237) ----------

  /** Asks the hub where you stand with each person in room `code` (the result screen; a `{t:'status'}` event follows). */
  loadRoom(code: string) {
    this.send({ t: 'room', code });
  }

  /** Where you stand with a seat key from RoomLink.addable. 'loading' until loadRoom has answered (a bot's: 'none'). */
  stateOf(key: string): SeatState | 'loading' {
    const s = this.seats.get(key);
    if (s) return s;
    return key.split('|')[1] === 'bot' ? 'none' : 'loading';
  }

  /** A friend request to a seat. A ranked bot's only looks sent: nothing goes anywhere. */
  request(key: string) {
    const [room, a] = key.split('|');
    const was = this.seats.get(key);
    this.seats.set(key, 'requested');
    this.emit({ t: 'status' });
    if (a === 'bot' || !room) return;
    this.lastSent = { key, was };
    this.send({ t: 'request', room, color: a as Color });
  }

  /**
   * Answers a request: by its id (the Requests list), or by a seat key whose state is 'incoming' (the result row's
   * Accept, which asks them back: the hub takes that as a yes).
   */
  answer(idOrKey: string, accept: boolean) {
    if (idOrKey.includes('|')) {
      if (accept) this.request(idOrKey);
      return;
    }
    this.send({ t: 'answer', id: idOrKey, accept });
  }
  remove(id: string) {
    this.send({ t: 'remove', id });
  }
  invite(to: string, room: string) {
    this.send({ t: 'invite', to, room });
  }
  reply(to: string, room: string, accept: boolean) {
    this.send({ t: 'reply', to, room, accept });
  }

  close() {
    this.setStatus('closed');
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.ws?.close();
  }
}

let current: FriendsLink | null = null;
const starters = new Set<(l: FriendsLink) => void>();

/** The app's friends link, if it has started. */
export const friendsLink = () => current;
/** Calls `f` with the link once it starts (at once if it has). */
export function onFriendsStart(f: (l: FriendsLink) => void): () => void {
  if (current) f(current);
  starters.add(f);
  return () => starters.delete(f);
}
/** Whether this device has a guest account already (so friends can start without asking for anything). */
export const hasAccount = () => !!savedKey();

/** Starts the link (once): the guest account (made on first use, named `name`), then the hub. */
export async function startFriends(name: string): Promise<FriendsLink> {
  if (current) return current;
  if (!roomsUrl()) throw new Error('online play is off');
  const account = await loadAccount(name);
  if (current) return current;
  current = new FriendsLink({ id: account.id, secret: account.secret }, account.name);
  for (const f of starters) f(current);
  return current;
}
