// The friends hub (#209, a first version): one Durable Object ("global") with every account's friend code, name
// and friends in SQLite, and the open WebSockets (hibernating) that make people online. The logic is
// friends-core.ts. A connection's first message is hello with its guest account, which the accounts store checks.
import { DurableObject } from 'cloudflare:workers';
import { PROTOCOL, type FriendClientMsg, type FriendServerMsg } from '../../src/net/protocol';
import type { Accounts } from './accounts';
import type { Room } from './index';
import { FriendsCore, type FriendStore } from './friends-core';
import { Bucket, SOCKETS_PER_IP_HUB, admit, clientIp } from './limits';

interface Env {
  ACCOUNTS: DurableObjectNamespace<Accounts>;
  /** #237: the rooms, asked who played each colour (for a friend request by seat). */
  ROOMS: DurableObjectNamespace<Room>;
}
interface Attachment {
  conn: string;
  /** #220: the socket's IP, and when it opened (to close one that never says hello). */
  ip?: string;
  since?: number;
  /** The account, once its hello checked out. */
  id: string | null;
  name: string;
}

const MAX_MESSAGE = 1024;

export class Friends extends DurableObject<Env> {
  private core: FriendsCore;
  /** #220: each socket's message budget (in memory). */
  private budgets = new WeakMap<WebSocket, Bucket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, code TEXT UNIQUE, name TEXT)');
    sql.exec('CREATE TABLE IF NOT EXISTS links (a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b))');
    // #237: friend requests (a asked b), and when each last asked another (kept after the answer: no repeat within a day).
    sql.exec('CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, at INTEGER NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS requests_b ON requests (b)');
    sql.exec('CREATE INDEX IF NOT EXISTS requests_a ON requests (a)');
    sql.exec('CREATE TABLE IF NOT EXISTS asked (a TEXT NOT NULL, b TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (a, b))');
    const one = <T>(q: string, ...v: SqlStorageValue[]) => (sql.exec(q, ...v).toArray()[0] as T | undefined) ?? null;
    const upsert = (id: string) => sql.exec('INSERT OR IGNORE INTO people (id) VALUES (?)', id);
    const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a]);
    const store: FriendStore = {
      codeOf: (id) => one<{ code: string | null }>('SELECT code FROM people WHERE id = ?', id)?.code ?? null,
      idOfCode: (code) => one<{ id: string }>('SELECT id FROM people WHERE code = ?', code)?.id ?? null,
      setCode: (id, code) => {
        upsert(id);
        sql.exec('UPDATE people SET code = ? WHERE id = ?', code, id);
      },
      nameOf: (id) => one<{ name: string | null }>('SELECT name FROM people WHERE id = ?', id)?.name ?? null,
      setName: (id, name) => {
        upsert(id);
        sql.exec('UPDATE people SET name = ? WHERE id = ?', name, id);
      },
      friendsOf: (id) => sql.exec<{ f: string }>('SELECT b AS f FROM links WHERE a = ? UNION SELECT a AS f FROM links WHERE b = ?', id, id).toArray().map((r) => r.f),
      link: (a, b) => void sql.exec('INSERT OR IGNORE INTO links (a, b) VALUES (?, ?)', ...pair(a, b)),
      unlink: (a, b) => void sql.exec('DELETE FROM links WHERE a = ? AND b = ?', ...pair(a, b)),
      // #237: requests, and when each person last asked another (for the day's no-repeat).
      addRequest: (r) => void sql.exec('INSERT INTO requests (id, a, b, at) VALUES (?, ?, ?, ?)', r.id, r.from, r.to, r.at),
      removeRequest: (id) => void sql.exec('DELETE FROM requests WHERE id = ?', id),
      requestsTo: (id) => sql.exec<{ id: string; a: string; b: string; at: number }>('SELECT id, a, b, at FROM requests WHERE b = ?', id).toArray().map((r) => ({ id: r.id, from: r.a, to: r.b, at: r.at })),
      requestsFrom: (id) => sql.exec<{ id: string; a: string; b: string; at: number }>('SELECT id, a, b, at FROM requests WHERE a = ?', id).toArray().map((r) => ({ id: r.id, from: r.a, to: r.b, at: r.at })),
      lastAsked: (a, b) => one<{ at: number }>('SELECT at FROM asked WHERE a = ? AND b = ?', a, b)?.at ?? null,
      setAsked: (a, b, at) => void sql.exec('INSERT INTO asked (a, b, at) VALUES (?, ?, ?) ON CONFLICT (a, b) DO UPDATE SET at = excluded.at', a, b, at),
    };
    this.core = new FriendsCore(store, {
      send: (conn, msg) => this.send(conn, msg),
      random: () => crypto.getRandomValues(new Uint32Array(1))[0]! / 4294967296,
      now: () => Date.now(),
      seatAccounts: (room, me) => this.env.ROOMS.get(this.env.ROOMS.idFromName(room)).seatAccounts(me),
    });
    // Keep-alive pings answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(JSON.stringify({ t: 'ping' }), JSON.stringify({ t: 'pong' })));
    // After hibernation: the connections still open are online again (quietly: nobody's status changed).
    for (const ws of ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.id) this.core.hello(a.conn, a.id, a.name, true);
    }
  }

  private send(conn: string, msg: FriendServerMsg) {
    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() as Attachment | null)?.conn !== conn) continue;
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        // Closing; its close handler cleans up.
      }
    }
  }

  async fetch(req: Request): Promise<Response> {
    // #220: so many sockets per IP on the hub; sockets that never said hello are closed.
    const ip = clientIp(req);
    const now = Date.now();
    const open = this.ctx.getWebSockets();
    const { ok, stale } = admit(open.map((ws) => {
      const a = ws.deserializeAttachment() as Attachment | null;
      return { ip: a?.ip ?? '', hello: !!a?.id, since: a?.since ?? now };
    }), ip, now, SOCKETS_PER_IP_HUB);
    for (const i of stale) open[i]!.close(4000, 'bad-message');
    if (!ok) return new Response('too many connections', { status: 429 });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ conn: crypto.randomUUID(), id: null, name: '', ip, since: now } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const fail = (code: Extract<FriendServerMsg, { t: 'error' }>['code'], message: string, close = false) => {
      try {
        ws.send(JSON.stringify({ t: 'error', code, message } satisfies FriendServerMsg));
        if (close) ws.close(4000, code);
      } catch {
        // Gone.
      }
    };
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return fail('bad-message', 'Message too large or not text.', true);
    // #220: a socket over its message budget is closed.
    let budget = this.budgets.get(ws);
    if (!budget) this.budgets.set(ws, (budget = new Bucket(undefined, undefined, Date.now())));
    if (!budget.take(Date.now())) return fail('rate-limited', 'Too many messages: the connection was closed.', true);
    let msg: FriendClientMsg;
    try {
      msg = JSON.parse(raw) as FriendClientMsg;
    } catch {
      return fail('bad-message', 'Not JSON.');
    }
    const a = ws.deserializeAttachment() as Attachment;
    if (!a.id) {
      if (msg?.t !== 'hello') return fail('bad-message', 'Say hello first.', true);
      if (msg.protocol !== PROTOCOL) return fail('protocol', 'This app version can’t use friends on this server. Please update the app.', true);
      const known = await this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName('global')).check(msg.account);
      if (!known) return fail('no-account', 'Your account wasn’t found. Try again.', true);
      // #220: one live friends link per account: an older one gives way.
      for (const other of this.ctx.getWebSockets()) {
        const o = other.deserializeAttachment() as Attachment | null;
        if (other === ws || o?.id !== msg.account.id) continue;
        this.core.bye(o.conn);
        other.serializeAttachment({ ...o, id: null } satisfies Attachment);
        try {
          other.send(JSON.stringify({ t: 'error', code: 'replaced', message: 'Friends opened somewhere else.' } satisfies FriendServerMsg));
          other.close(4000, 'replaced');
        } catch {
          // Gone.
        }
      }
      ws.serializeAttachment({ ...a, id: msg.account.id, name: msg.name } satisfies Attachment);
      this.core.hello(a.conn, msg.account.id, msg.name);
      return;
    }
    const err = await this.core.handle(a.conn, msg);
    if (err) fail(err, MESSAGES[err] ?? 'That didn’t work.');
  }

  async webSocketClose(ws: WebSocket) {
    this.closed(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.closed(ws);
  }

  private closed(ws: WebSocket) {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (a?.id) this.core.bye(a.conn);
  }
}

const MESSAGES: Partial<Record<string, string>> = {
  'no-friend': 'No one has that friend code.',
  'not-friends': 'You can only invite friends.',
  offline: 'They aren’t online right now.',
  full: 'That friends list is full.',
  'bad-message': 'The app sent something the server didn’t understand.',
};
