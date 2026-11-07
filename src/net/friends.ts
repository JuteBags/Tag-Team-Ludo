// Friends (#209, a first version): the app's one WebSocket to the server's friends hub (GET /fr). It says hello with
// this device's guest account (ranked.ts loadAccount: made on first use), then keeps the friend code and the
// friends list (who's online) up to date, and carries invites into private rooms and their answers. It
// reconnects with backoff and pings to stay up. Online play only, so it starts only after the terms (#208).
import { roomsUrl } from './client';
import { PROTOCOL, type AccountKey, type Friend, type FriendClientMsg, type FriendServerMsg } from './protocol';
import { loadAccount, savedKey } from './ranked';

const PING_MS = 20_000;
type Event = FriendServerMsg | { t: 'status' };

export class FriendsLink {
  status: 'connecting' | 'open' | 'retrying' | 'closed' = 'connecting';
  /** This account's friend code (once the hub has said). */
  code = '';
  friends: Friend[] = [];
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
    if (m.t === 'me') {
      this.code = m.code;
      this.friends = m.friends;
      this.setStatus('open');
    } else if (m.t === 'friend') {
      const rest = this.friends.filter((f) => f.id !== m.friend.id);
      this.friends = m.gone ? rest : [...rest, m.friend];
    }
    this.emit(m);
  }

  private send(m: FriendClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  add(code: string) {
    this.send({ t: 'add', code: code.trim().toUpperCase() });
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
