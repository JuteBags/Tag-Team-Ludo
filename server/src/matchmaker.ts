// Ranked matchmaking: one Durable Object per mode ("mm:<mode>") holding everyone searching, each on an open
// WebSocket. Every second it groups people whose ratings are close enough (the window grows the longer they
// wait); after BOT_FILL_MS, ranked bots at the person's rating fill whatever places are still empty. A group
// becomes a ranked room (Room.createRanked), and each person gets its code and their own token.
import { DurableObject } from 'cloudflare:workers';
import { PROTOCOL, type ErrorCode, type GameMode, type QueueClientMsg, type QueueServerMsg, type RoomOptions } from '../../src/net/protocol';
import { BOT_FILL_MS, botLevelFor, matchWindow } from '../../src/net/rating';
import { findMatches, type Waiting } from './queue';
import type { Accounts } from './accounts';
import type { Room } from './index';
import { cleanName } from './room-core';

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ACCOUNTS: DurableObjectNamespace<Accounts>;
}

interface Attachment {
  mode: GameMode;
  entry: Waiting | null;
}

const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

export class Matchmaker extends DurableObject<Env> {
  /** Makes a room code (the Worker's alphabet), set by index.ts so both use one. */
  static newCode: () => string = () => hex(3).toUpperCase().slice(0, 5);

  async fetch(req: Request): Promise<Response> {
    const mode = new URL(req.url).searchParams.get('mode') as GameMode;
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ mode, entry: null } satisfies Attachment);
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
    ws.serializeAttachment({ mode: a.mode, entry } satisfies Attachment);
    await this.tick();
  }

  async webSocketClose() {
    await this.tick();
  }

  async alarm() {
    await this.tick();
  }

  /** Starts every game that can start, tells everyone else how their search is going, and keeps the clock running. */
  private async tick() {
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
        const ws = byId.get(w.id)!;
        this.send(ws, { t: 'matched', code, token: tokens[i]!, mode });
        ws.serializeAttachment({ mode, entry: null } satisfies Attachment);
        ws.close(1000, 'matched');
        byId.delete(w.id);
      });
    }
    for (const ws of byId.values()) {
      const e = (ws.deserializeAttachment() as Attachment).entry!;
      this.send(ws, { t: 'search', rating: e.rating, waited: now - e.since, window: matchWindow(now - e.since), searching: byId.size, botsAt: Math.max(0, BOT_FILL_MS - (now - e.since)) });
    }
    if (byId.size) await this.ctx.storage.setAlarm(now + 1000);
    else await this.ctx.storage.deleteAlarm();
  }
}
