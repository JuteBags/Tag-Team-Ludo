// The app's side of a private room: one WebSocket to the room server (server/), kept open (reconnecting
// with backoff when the network drops or the app comes back from the background), and the game as an
// ordered stream of events for the game screen.
//
// The server's event list only ever grows, so the link keeps every event it has seen and hands them to the
// game screen one at a time (next()). A `game` message (on every reconnect) fills in anything missed; an `ev`
// already seen is ignored; an `ev` past a gap forces a reconnect, whose `game` message fills the gap.
import { PROTOCOL, type ClientMsg, type ErrorCode, type GameSetup, type Member, type RoomOptions, type ServerMsg, type Turn } from './protocol';

/**
 * The room server's address: VITE_ROOMS_URL at build time; this computer's `wrangler dev` while developing;
 * otherwise the site the game was loaded from, when that's the room server itself (the staging Worker
 * serves the game too). In the APK (https://localhost) without VITE_ROOMS_URL, online play is off.
 */
export function roomsUrl(): string {
  const set = (import.meta.env.VITE_ROOMS_URL as string | undefined)?.trim();
  if (set) return set.replace(/\/+$/, '');
  if (import.meta.env.DEV) return `ws://${location.hostname || 'localhost'}:8787`;
  if (location.protocol === 'https:' && location.hostname.endsWith('.workers.dev')) return `wss://${location.host}`;
  return '';
}

/** A fresh secret id for this person in one room (32 hex characters). */
export const newToken = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Errors after which reconnecting can't help. */
const FATAL: ErrorCode[] = ['protocol', 'no-room', 'full', 'started', 'expired'];
const PING_MS = 20_000;
const PONG_MS = 8_000;
const BACKOFF = [500, 1000, 2000, 4000, 8000];

export type LinkStatus = 'connecting' | 'open' | 'retrying' | 'closed';

/** The room the device is in, kept so a closed app can rejoin it. */
export interface SavedRoom {
  code: string;
  token: string;
  name: string;
  at: number;
}
const ROOM_KEY = 'ludo-online-room';
export function loadRoom(): SavedRoom | null {
  try {
    const r = JSON.parse(localStorage.getItem(ROOM_KEY) ?? 'null') as SavedRoom | null;
    // A room is gone 2 hours after its last activity (server IDLE_MS).
    return r && typeof r.code === 'string' && Date.now() - r.at < 2 * 3600_000 ? r : null;
  } catch {
    return null;
  }
}
export function saveRoom(r: SavedRoom | null) {
  try {
    if (r) localStorage.setItem(ROOM_KEY, JSON.stringify({ ...r, at: Date.now() }));
    else localStorage.removeItem(ROOM_KEY);
  } catch {
    // Storage blocked: the room can't be rejoined after the app closes, that's all.
  }
}

export class RoomLink {
  status: LinkStatus = 'connecting';
  code = '';
  you = -1;
  options: RoomOptions | null = null;
  /** When the lobby's wait ends (performance.now time). */
  lobbyEnds = 0;
  members: Member[] = [];
  setup: GameSetup | null = null;
  turn: Turn | null = null;
  /** When `turn` was received (performance.now), to count its time down. */
  turnAt = 0;
  over: Extract<ServerMsg, { t: 'over' }> | null = null;
  /** A fatal error: the room can't be (re)joined. */
  fatal: { code: ErrorCode; message: string } | null = null;

  private ws: WebSocket | null = null;
  private events: string[] = [];
  private consumed = 0;
  private waiting: ((ev: string) => void) | null = null;
  private outbox: ClientMsg[] = [];
  private listeners = new Set<(m: ServerMsg | { t: 'status' }) => void>();
  private tries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  private onVisible = () => {
    // Back from the background: a socket the OS killed is reopened at once.
    if (document.visibilityState === 'visible' && this.status !== 'closed' && this.ws?.readyState !== WebSocket.OPEN) this.reconnect(0);
  };

  /** `first`: the query that opens the room (`create=...` or `code=...`); reconnects always use the code. */
  private constructor(private base: string, private first: string, readonly token: string, readonly name: string) {
    document.addEventListener('visibilitychange', this.onVisible);
    this.open();
  }

  static create(options: RoomOptions, name: string): RoomLink {
    return new RoomLink(roomsUrl(), `create=${encodeURIComponent(JSON.stringify(options))}`, newToken(), name);
  }

  static join(code: string, name: string, token = newToken()): RoomLink {
    return new RoomLink(roomsUrl(), `code=${encodeURIComponent(code.toUpperCase())}`, token, name);
  }

  /** Every message (and status changes); returns the unsubscribe. */
  on(f: (m: ServerMsg | { t: 'status' }) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private emit(m: ServerMsg | { t: 'status' }) {
    for (const f of [...this.listeners]) f(m);
  }

  private setStatus(s: LinkStatus) {
    this.status = s;
    this.emit({ t: 'status' });
  }

  private open() {
    const q = this.code ? `code=${this.code}` : this.first;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${this.base}/ws?${q}`);
    } catch {
      return this.reconnect();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.tries = 0;
      ws.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL, token: this.token, name: this.name } satisfies ClientMsg));
      // Actions made while offline go now (the server turns down any that went stale meanwhile).
      for (const m of this.outbox.splice(0)) ws.send(JSON.stringify(m));
      this.setStatus('open');
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.ping(), PING_MS);
    };
    ws.onmessage = (e) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      this.receive(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      clearTimeout(this.pongTimer);
      this.ws = null;
      if (this.status !== 'closed') this.reconnect();
    };
  }

  private ping() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ t: 'ping' } satisfies ClientMsg));
    clearTimeout(this.pongTimer);
    // No answer: the connection is dead even if the socket doesn't know yet.
    this.pongTimer = setTimeout(() => this.ws?.close(), PONG_MS);
  }

  private reconnect(delay = BACKOFF[Math.min(this.tries, BACKOFF.length - 1)]!) {
    if (this.status === 'closed' || this.fatal) return;
    this.tries++;
    clearTimeout(this.retryTimer);
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onclose = null;
      old.close();
    }
    this.setStatus('retrying');
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  private receive(m: ServerMsg) {
    switch (m.t) {
      case 'pong':
        clearTimeout(this.pongTimer);
        return;
      case 'lobby':
        this.code = m.code;
        this.you = m.you;
        this.options = m.options;
        this.members = m.members;
        this.lobbyEnds = performance.now() + m.endsIn;
        saveRoom({ code: m.code, token: this.token, name: this.name, at: Date.now() });
        break;
      case 'game':
        this.code = m.code;
        this.you = m.you;
        this.setup = m.setup;
        this.members = m.members;
        this.setTurn(m.turn);
        // Anything missed while away; what we have is always the start of the server's list.
        for (let i = this.events.length; i < m.events.length; i++) this.push(m.events[i]!);
        saveRoom({ code: m.code, token: this.token, name: this.name, at: Date.now() });
        break;
      case 'ev':
        if (m.seq < this.events.length) return; // seen already
        if (m.seq > this.events.length) return this.reconnect(0); // a gap: the reconnect's sync fills it
        this.push(m.ev);
        this.setTurn(m.turn);
        break;
      case 'members':
        this.members = m.members;
        break;
      case 'over':
        this.over = m;
        saveRoom(null);
        break;
      case 'error':
        if (FATAL.includes(m.code)) {
          this.fatal = { code: m.code, message: m.message };
          saveRoom(null);
          this.close();
        }
        break;
    }
    this.emit(m);
  }

  private setTurn(t: Turn | null) {
    this.turn = t;
    this.turnAt = performance.now();
  }

  /** Seconds left on the current turn's clock, or null (a bot's turn, or none). */
  secondsLeft(): number | null {
    if (!this.turn || this.turn.ms === null) return null;
    return Math.max(0, Math.ceil((this.turn.ms - (performance.now() - this.turnAt)) / 1000));
  }

  private push(ev: string) {
    this.events.push(ev);
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      this.consumed++;
      w(ev);
    }
  }

  /** The game's events not handed out yet, all at once (a game screen starting mid-game catches up with these). */
  drain(): string[] {
    const out = this.events.slice(this.consumed);
    this.consumed = this.events.length;
    return out;
  }

  /** The next event, in order (waits for the server). One caller at a time. */
  next(): Promise<string> {
    if (this.consumed < this.events.length) return Promise.resolve(this.events[this.consumed++]!);
    return new Promise((r) => (this.waiting = r));
  }

  /** Events received but not handed out yet: the game screen hurries its animations when it falls behind. */
  backlog(): number {
    return this.events.length - this.consumed;
  }

  /** Events handed out so far: the sequence number of the next action. */
  get seq(): number {
    return this.consumed;
  }

  send(m: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
    else if (m.t === 'roll' || m.t === 'move') this.outbox.push(m);
  }

  /** Leaves the room (the server frees the seat, or a bot plays on for us) and closes. */
  leave() {
    this.send({ t: 'leave' });
    saveRoom(null);
    // Give the message a moment to go before the socket closes.
    setTimeout(() => this.close(), 150);
  }

  /** Closes the connection for good (the room carries on without us). */
  close() {
    if (this.status === 'closed') return;
    this.status = 'closed';
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    this.emit({ t: 'status' });
  }
}
