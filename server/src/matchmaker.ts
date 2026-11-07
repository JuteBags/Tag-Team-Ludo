// Ranked matchmaking: one Durable Object per mode ("mm:<mode>") holding everyone searching, each on an open
// WebSocket. Every second it groups people whose ratings are close enough (the window grows the longer they
// wait), by the league rules (queue.ts, rating.ts canMatch); up to Gold III, after BOT_FILL_MS, bots at the
// person's rating fill whatever places are still empty, looking like players (#216). A group
// becomes a ranked room (Room.createRanked), and each person gets its code and their own token.
import { DurableObject } from 'cloudflare:workers';
import { PROTOCOL, type ErrorCode, type GameMode, type QueueClientMsg, type QueueServerMsg, type RoomOptions } from '../../src/net/protocol';
import { botLevelFor, matchWindow } from '../../src/net/rating';
import { findMatches, type Waiting } from './queue';
import type { Accounts } from './accounts';
import type { Room } from './index';
import { cleanName } from './room-core';
import { SOCKETS_PER_IP_HUB, admit, clientIp } from './limits';

/** #220: the queue's only message is small. */
const MAX_MESSAGE = 1024;

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ACCOUNTS: DurableObjectNamespace<Accounts>;
}

interface Attachment {
  mode: GameMode;
  entry: Waiting | null;
  /** #220: the socket's IP, and when it opened (to close one that never says hello). */
  ip?: string;
  since?: number;
}

const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

export class Matchmaker extends DurableObject<Env> {
  /** Makes a room code (the Worker's alphabet), set by index.ts so both use one. */
  static newCode: () => string = () => hex(3).toUpperCase().slice(0, 5);

  async fetch(req: Request): Promise<Response> {
    const mode = new URL(req.url).searchParams.get('mode') as GameMode;
    // #220: so many sockets per IP in the queue; sockets that never sent their search are closed.
    const ip = clientIp(req);
    const now = Date.now();
    const open = this.ctx.getWebSockets();
    const { ok, stale } = admit(open.map((ws) => {
      const a = ws.deserializeAttachment() as Attachment | null;
      return { ip: a?.ip ?? '', hello: !!a?.entry, since: a?.since ?? now };
    }), ip, now, SOCKETS_PER_IP_HUB);
    for (const i of stale) this.fail(open[i]!, 'bad-message', 'Say what to search for first.');
    if (!ok) return new Response('too many connections', { status: 429 });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ mode, entry: null, ip, since: now } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(ws: WebSocket, m: QueueServerMsg) {
    try {
      ws.send(JSON.stringify(m));
    } catch {
      // Gone.
    }
  }

  private fail(ws: WebSocket, code: ErrorCode, message: string) {
    this.send(ws, { t: 'error', code, message });
    try {
      ws.close(4000, code);
    } catch {
      // Gone.
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    // #220: one small message per socket (any other is turned away below, and the socket closed).
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return this.fail(ws, 'bad-message', 'Message too large or not text.');
    let msg: QueueClientMsg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : '') as QueueClientMsg;
    } catch {
      return this.fail(ws, 'bad-message', 'Not JSON.');
    }
    const a = ws.deserializeAttachment() as Attachment;
    if (msg.t === 'leave') return ws.close(1000, 'left');
    if (msg.t !== 'queue' || a.entry) return this.fail(ws, 'bad-message', 'Unexpected message.');
    if (msg.protocol !== PROTOCOL) return this.fail(ws, 'protocol', 'This app version can’t play with the server. Please update the app.');
    const account = await this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName('global')).check(msg.account);
    if (!account) return this.fail(ws, 'no-account', 'Your ranked account wasn’t found. Try again.');
    // One search per account: an older one (another tab) gives way.
    for (const other of this.ctx.getWebSockets())
      if (other !== ws && (other.deserializeAttachment() as Attachment).entry?.id === msg.account.id) this.fail(other, 'in-queue', 'You started searching somewhere else.');
    const entry: Waiting = { id: msg.account.id, name: cleanName(msg.name), rating: account.ratings[a.mode].rating, since: Date.now() };
    ws.serializeAttachment({ ...a, mode: a.mode, entry } satisfies Attachment);
    await this.tick();
  }

  async webSocketClose() {
    await this.tick();
  }

  async alarm() {
    await this.tick();
  }

  /** A pass is running (they await the rooms, so another could start mid-way and match someone twice). */
  private busy = false;
  private again = false;

  /** One matching pass at a time; a call during one asks for another pass after it. */
  private async tick() {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      do {
        this.again = false;
        await this.pass();
      } while (this.again);
    } finally {
      this.busy = false;
    }
  }

  /** Starts every game that can start, tells everyone else how their search is going, and keeps the clock running. */
  private async pass() {
    const now = Date.now();
    const open = this.ctx.getWebSockets().filter((ws) => (ws.deserializeAttachment() as Attachment | null)?.entry);
    if (!open.length) return void this.ctx.storage.deleteAlarm();
    const mode = (open[0]!.deserializeAttachment() as Attachment).mode;
    const byId = new Map(open.map((ws) => [(ws.deserializeAttachment() as Attachment).entry!.id, ws]));
    const matches = findMatches([...byId.keys()].map((id) => (byId.get(id)!.deserializeAttachment() as Attachment).entry!), mode, now);
    for (const m of matches) {
      const tokens = m.slots.map((w) => (w ? hex(16) : ''));
      const options: RoomOptions = { mode, pairing: 'opposite', singles: false, botLevel: botLevelFor(m.botRating) };
      const slots = m.slots.map((w, i) => (w ? { token: tokens[i]!, name: w.name, account: w.id } : null));
      let code = '';
      for (let i = 0; i < 5 && !code; i++) {
        const c = Matchmaker.newCode();
        if (await this.env.ROOMS.get(this.env.ROOMS.idFromName(c)).createRanked(c, options, slots, m.botRating)) code = c;
      }
      if (!code) continue; // Try again next second.
      m.slots.forEach((w, i) => {
        if (!w) return;
        // If they cancelled while the room was made, the game goes on without them (they forfeit after a minute).
        const ws = byId.get(w.id);
        if (!ws) return;
        this.send(ws, { t: 'matched', code, token: tokens[i]!, mode });
        ws.serializeAttachment({ mode, entry: null } satisfies Attachment);
        ws.close(1000, 'matched');
        byId.delete(w.id);
      });
    }
    for (const ws of byId.values()) {
      const e = (ws.deserializeAttachment() as Attachment).entry!;
      this.send(ws, { t: 'search', rating: e.rating, waited: now - e.since, window: matchWindow(now - e.since), searching: byId.size, botsAt: 0 /* bots fill silently (#216): no countdown */ });
    }
    if (byId.size) await this.ctx.storage.setAlarm(now + 1000);
    else await this.ctx.storage.deleteAlarm();
  }
}
