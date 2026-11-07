// The room server: a Cloudflare Worker that routes each WebSocket to its room, and the Room Durable Object
// (one per room code) that runs it. All game logic is in room-core.ts; this file is only the wiring.
//
//   GET /health                          {"ok":true,"protocol":2}
//   GET /ws?create={"mode":"ffa",...}    a new private room (the first message back is its lobby, with the code)
//   GET /ws?code=ABCDE                   join a room (private, or the ranked game the queue matched you into)
//   GET /mm?mode=1v1                     ranked: search for a game (a WebSocket to that mode's Matchmaker)
//   POST /api/account                    your guest account (ranked ratings, friends) (accounts.ts)
//   GET /fr                              friends: your code, your friends online, invites (friends.ts)
// Then the app's first message is `hello` (src/net/protocol.ts), or `queue` on /mm.
import { DurableObject } from 'cloudflare:workers';
import { CODE_ALPHABET, CODE_LEN, GAME_MODES, PROTOCOL, isCode, type AccountKey, type ClientMsg, type ErrorCode, type GameMode, type RoomOptions, type ServerMsg } from '../../src/net/protocol';
import { Accounts } from './accounts';
import { Friends } from './friends';
import { Matchmaker } from './matchmaker';
import { RoomCore, validOptions, type RoomData, type RoomIO } from './room-core';

export { Accounts, Friends, Matchmaker };

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  MATCH: DurableObjectNamespace<Matchmaker>;
  ACCOUNTS: DurableObjectNamespace<Accounts>;
  FRIENDS: DurableObjectNamespace<Friends>;
  /** Tests only: "1" turns on POST /api/test/rating (CI passes it to wrangler dev; no environment sets it). */
  TEST_HOOKS?: string;
  /** Comma-separated origins allowed to open a WebSocket, or "*" (dev). Requests with no Origin (native) always pass. */
  ALLOWED_ORIGINS: string;
}

const MAX_MESSAGE = 2048;
const TOKEN = /^[0-9a-f]{32}$/;

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });

function originOk(req: Request, env: Env): boolean {
  const origin = req.headers.get('Origin');
  if (!origin || env.ALLOWED_ORIGINS.trim() === '*') return true;
  // The game served by this Worker itself (staging serves it from its own address).
  if (origin === new URL(req.url).origin) return true;
  return env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).includes(origin);
}

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
Matchmaker.newCode = newCode;

const accounts = (env: Env) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName('global'));

/** POST /api/account: the guest account (made on the first call) and its ratings. */
async function account(req: Request, env: Env): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body: { id?: string; secret?: string; name?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'bad body' }, 400);
  }
  const key: AccountKey | null = body.id && body.secret ? { id: body.id, secret: body.secret } : null;
  const reply = await accounts(env).account(key, String(body.name ?? ''));
  return reply ? json(reply) : json({ error: 'no-account' }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true, protocol: PROTOCOL });
    if (url.pathname === '/api/account') return account(req, env);
    if (url.pathname === '/api/test/rating' && env.TEST_HOOKS === '1' && req.method === 'POST') {
      const b = (await req.json().catch(() => null)) as { id?: string; secret?: string; mode?: GameMode; rating?: number; games?: number } | null;
      const ok = !!b?.id && !!b.secret && (await accounts(env).testSetRating({ id: b.id, secret: b.secret }, b.mode!, Number(b.rating), Number(b.games ?? 20)));
      return json({ ok }, ok ? 200 : 400);
    }
    if (url.pathname !== '/ws' && url.pathname !== '/mm' && url.pathname !== '/fr') return json({ error: 'not found' }, 404);
    if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected a WebSocket' }, 426);
    if (!originOk(req, env)) return json({ error: 'origin not allowed' }, 403);
    if (url.pathname === '/fr') return env.FRIENDS.get(env.FRIENDS.idFromName('global')).fetch(req);
    if (url.pathname === '/mm') {
      const mode = url.searchParams.get('mode') as GameMode;
      if (!GAME_MODES.includes(mode)) return json({ error: 'bad mode' }, 400);
      return env.MATCH.get(env.MATCH.idFromName(`mm:${mode}`)).fetch(req);
    }

    const create = url.searchParams.get('create');
    if (create !== null) {
      let options;
      try {
        options = validOptions(JSON.parse(create));
      } catch {
        options = null;
      }
      if (!options) return json({ error: 'bad room options' }, 400);
      // A new code; on the rare clash with a live room, another one.
      for (let i = 0; i < 5; i++) {
        const code = newCode();
        const target = new URL(req.url);
        target.search = `?code=${code}&create=${encodeURIComponent(JSON.stringify(options))}`;
        const res = await env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(target, req));
        if (res.status !== 409) return res;
      }
      return json({ error: 'no free room code' }, 503);
    }
    const code = (url.searchParams.get('code') ?? '').toUpperCase();
    if (!isCode(code)) return json({ error: 'bad room code' }, 400);
    const target = new URL(req.url);
    target.search = `?code=${code}`;
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(target, req));
  },
} satisfies ExportedHandler<Env>;

interface Attachment {
  token: string | null;
}

export class Room extends DurableObject<Env> {
  private core: RoomCore | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The app's keep-alive pings are answered without waking the object (no compute, no storage reads).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(JSON.stringify({ t: 'ping' }), JSON.stringify({ t: 'pong' })));
    // After hibernation: the room from storage, and the connections still open.
    ctx.blockConcurrencyWhile(async () => {
      const data = await ctx.storage.get<RoomData>('room');
      if (!data) return;
      this.core = new RoomCore(data, this.io());
      for (const ws of ctx.getWebSockets()) {
        const a = ws.deserializeAttachment() as Attachment | null;
        if (a?.token) this.core.reattach(a.token);
      }
    });
  }

  private io(): RoomIO {
    const ctx = this.ctx;
    return {
      now: () => Date.now(),
      send: (token, msg) => {
        const text = JSON.stringify(msg);
        for (const ws of ctx.getWebSockets()) {
          if ((ws.deserializeAttachment() as Attachment | null)?.token === token) {
            try {
              ws.send(text);
            } catch {
              // Closing already; its close handler cleans up.
            }
          }
        }
      },
      setAlarm: (at) => void (at === null ? ctx.storage.deleteAlarm() : ctx.storage.setAlarm(at)),
      save: (data) => void ctx.storage.put('room', data),
      destroy: () => {
        for (const ws of ctx.getWebSockets()) ws.close(1000, 'room closed');
        this.core = null;
        void ctx.storage.deleteAlarm();
        void ctx.storage.deleteAll();
      },
      random: () => crypto.getRandomValues(new Uint32Array(1))[0]! / 4294967296,
      // A reported chat line (#212), for review in the Worker's logs (observability is on). Chat keeps nothing else.
      report: (r) => console.log(JSON.stringify({ type: 'chat-report', ...r })),
      rate: (report) => accounts(this.env).rate(report),
    };
  }

  /** Ranked: the queue made this room (false when the code is already taken). It starts at once. */
  async createRanked(code: string, options: RoomOptions, slots: ({ token: string; name: string; account: string } | null)[], botRating: number): Promise<boolean> {
    if (this.core) return false;
    this.core = RoomCore.ranked(code, options, slots, botRating, this.io());
    return true;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const code = url.searchParams.get('code')!;
    const create = url.searchParams.get('create');
    if (create !== null) {
      if (this.core) return new Response('taken', { status: 409 });
      this.core = RoomCore.create(code, validOptions(JSON.parse(create))!, this.io());
    }
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ token: null } satisfies Attachment);
    // No such room: say so on the socket (a browser can't read an HTTP error from a failed WebSocket).
    if (!this.core) this.fail(server, 'no-room', 'There is no room with that code.');
    return new Response(null, { status: 101, webSocket: client });
  }

  private fail(ws: WebSocket, code: ErrorCode, message: string, close = true) {
    try {
      ws.send(JSON.stringify({ t: 'error', code, message } satisfies ServerMsg));
      if (close) ws.close(4000, code);
    } catch {
      // Already gone.
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return this.fail(ws, 'bad-message', 'Message too large or not text.');
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      return this.fail(ws, 'bad-message', 'Not JSON.');
    }
    if (!this.core) return this.fail(ws, 'no-room', 'There is no room with that code.');
    const a = ws.deserializeAttachment() as Attachment;
    if (!a.token) {
      if (msg?.t !== 'hello' || typeof msg.token !== 'string' || !TOKEN.test(msg.token)) return this.fail(ws, 'bad-message', 'Say hello first.');
      // Attach first, so the room's first messages (sent during hello) reach this connection.
      ws.serializeAttachment({ token: msg.token } satisfies Attachment);
      const err = this.core.hello(msg.token, msg);
      if (err) {
        ws.serializeAttachment({ token: null } satisfies Attachment);
        return this.fail(ws, err, ERRORS[err]);
      }
      return;
    }
    const err = await this.core.handle(a.token, msg);
    if (err) this.fail(ws, err, ERRORS[err], false);
  }

  async webSocketClose(ws: WebSocket) {
    this.closed(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.closed(ws);
  }

  private closed(ws: WebSocket) {
    const token = (ws.deserializeAttachment() as Attachment | null)?.token;
    if (!token || !this.core) return;
    const others = this.ctx.getWebSockets().some((w) => w !== ws && (w.deserializeAttachment() as Attachment | null)?.token === token);
    if (!others) this.core.disconnected(token);
  }

  async alarm() {
    this.core?.alarm();
  }
}

const ERRORS: Record<ErrorCode, string> = {
  protocol: 'This app version can’t play with the server. Please update the app.',
  'no-room': 'There is no room with that code.',
  full: 'This room is full.',
  started: 'This game has already started.',
  expired: 'Nobody joined in time, so the room closed.',
  'not-host': 'Only the host can start the game.',
  'not-enough': 'At least two people are needed to start.',
  'not-your-turn': 'It’s not your turn.',
  stale: 'That was already played.',
  'no-account': 'Your ranked account wasn’t found. Try again.',
  'in-queue': 'You started searching somewhere else.',
  illegal: 'That move isn’t allowed.',
  'bad-message': 'The app sent something the server didn’t understand.',
  'no-friend': 'No one has that friend code.',
  'not-friends': 'You can only invite friends.',
  offline: 'They aren’t online right now.',
};
