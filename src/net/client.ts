// The app's side of a private room: one WebSocket to the room server (server/), kept open (reconnecting
// with backoff when the network drops or the app comes back from the background), and the game as an
// ordered stream of events for the game screen.
//
// The server's event list only ever grows, so the link keeps every event it has seen and hands them to the
// game screen one at a time (next()). A `game` message (on every reconnect) fills in anything missed; an `ev`
// already seen is ignored; an `ev` past a gap forces a reconnect, whose `game` message fills the gap.
//
// Ranked bots (#221, localBots.ts): this link plays them itself, at a person's pace, with the server's draws for
// the dice, and adds their events to the stream as if the server had sent them. They go to the server with this
// person's next roll or move. When the server's version of a bot event differs, the link says so, takes the
// server's, and counts a rewind: the game screen rebuilds from played().
import { RESIGN, STOP_EVENT, applyEvent, type GameState } from '../engine';
import { BOT_VERSION, botPace, botStep, drawsUsed, isLocalBot, replayEvents, type Draws, type LocalBots } from './localBots';
import { PROTOCOL, TURN_MS, type ChatFeatures, type ClientMsg, type ErrorCode, type GameSetup, type Member, type RoomOptions, type ServerMsg, type Turn } from './protocol';

/**
 * The room server's address: VITE_ROOMS_URL, and only that. Set ROOMS_URL (the CI repository variable, or the
 * local environment); the build exposes it as VITE_ROOMS_URL. Without it, online play is hidden.
 */
export function roomsUrl(): string {
  const set = (import.meta.env.VITE_ROOMS_URL as string | undefined)?.trim();
  return set ? set.replace(/\/+$/, '') : '';
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
  /** A ranked game (rejoined from Ranked PvP, not With friends). */
  ranked?: boolean;
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
  /** What the room's chat allows (#212), or null: the server has no chat. */
  chat: ChatFeatures | null = null;
  turn: Turn | null = null;
  /** When `turn` was received (performance.now), to count its time down. */
  turnAt = 0;
  over: Extract<ServerMsg, { t: 'over' }> | null = null;
  /** Ranked: this person's rating change, once the game is rated. */
  rated: Extract<ServerMsg, { t: 'rated' }> | null = null;
  /** A fatal error: the room can't be (re)joined. */
  fatal: { code: ErrorCode; message: string } | null = null;

  /** #221: times the server's events replaced some of this app's bot events (the game screen rebuilds then). */
  rewinds = 0;

  private ws: WebSocket | null = null;
  private events: string[] = [];
  // ---- the bots this app plays (#221) ----
  private bots: LocalBots | null = null;
  /** The draws for the bots' current run, and how many its rolls have used. */
  private draws: Draws | null = null;
  private used = 0;
  /** Events the server has; the ones after are this app's bot events, not confirmed yet. */
  private confirmed = 0;
  /** The game after every event (the server's and this app's). */
  private state: GameState | null = null;
  private botTimer: ReturnType<typeof setTimeout> | undefined;
  /** What was last asked of the server (more draws, or the run that ended the game), so it's asked once. */
  private asked = '';
  /** The server's last turn, and when it came. */
  private serverTurn: Turn | null = null;
  private serverTurnAt = 0;
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
      ws.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL, token: this.token, name: this.name, botVersion: BOT_VERSION } satisfies ClientMsg));
      // Actions made while offline go now (the server turns down any that went stale meanwhile).
      for (const m of this.outbox.splice(0)) ws.send(JSON.stringify(m));
      this.setStatus('open');
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.ping(), PING_MS);
    };
    ws.onmessage = (e) => {
      // A socket this link has replaced (a reconnect) says nothing more: the server tells it 'replaced' (#220).
      if (this.ws !== ws) return;
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
        this.chat = m.chat ?? null;
        this.lobbyEnds = performance.now() + m.endsIn;
        saveRoom({ code: m.code, token: this.token, name: this.name, at: Date.now() });
        break;
      case 'game':
        this.code = m.code;
        this.you = m.you;
        this.setup = m.setup;
        this.members = m.members;
        this.chat = m.chat ?? null;
        this.bots = m.bots ?? null;
        if (!this.state && !this.events.length) this.state = replayEvents(m.setup.seats, m.setup.first, m.setup.singles, []);
        this.adopt(m.events);
        // A game this link couldn't follow (an event it couldn't apply): rebuilt from the whole list.
        if (!this.state) this.state = replayEvents(m.setup.seats, m.setup.first, m.setup.singles, this.events);
        if (m.draws) this.setDraws(m.draws);
        this.setServerTurn(m.turn);
        saveRoom({ code: m.code, token: this.token, name: this.name, at: Date.now(), ...(m.setup.ranked ? { ranked: true } : {}) });
        break;
      case 'ev':
        if (m.seq < this.confirmed) return; // seen already
        if (m.seq > this.confirmed) return this.reconnect(0); // a gap: the reconnect's sync fills it
        if (m.seq < this.events.length) {
          // This app played a bot event here already: the server's is the one that counts.
          if (this.events[m.seq] !== m.ev) {
            if (m.ev[0] !== RESIGN && m.ev !== STOP_EVENT) this.send({ t: 'mismatch', seq: m.seq, ev: this.events[m.seq]! });
            this.rewind(m.seq, [...this.events.slice(0, m.seq), m.ev]);
          }
        } else this.push(m.ev);
        this.confirmed = m.seq + 1;
        if (m.draws) this.setDraws(m.draws);
        this.setServerTurn(m.turn);
        break;
      case 'draws':
        if (this.draws && m.at === this.draws.at) {
          this.draws.d.push(...m.d);
          this.pump();
        }
        break;
      case 'members':
        this.members = m.members;
        break;
      case 'rated':
        this.rated = m;
        break;
      case 'over':
        this.over = m;
        saveRoom(null);
        break;
      case 'error':
        // #220: this game is open on another connection now (another tab): this one stops, the room is kept.
        if (m.code === 'replaced') {
          this.fatal = { code: m.code, message: m.message };
          this.close();
        } else if (FATAL.includes(m.code)) {
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

  private setServerTurn(t: Turn | null) {
    this.serverTurn = t;
    this.serverTurnAt = performance.now();
    this.showTurn(true);
  }

  /**
   * The clock to show. Without bots the server's. A ranked bot's turn shows a person's TURN_MS (#216), a shown bot's none; after the bots'
   * run this app played, the next person's clock is what's left of the server's, TURN_MS at most.
   */
  private showTurn(fresh = false) {
    const s = this.state;
    if (!this.bots || !s || s.phase === 'over') return this.setTurn(this.serverTurn);
    const color = s.players[s.current]!.color;
    if (isLocalBot(s, this.bots)) {
      // A private room's bots are shown as bots: no clock on their turn (#226).
      if (fresh || this.turn?.color !== color) this.setTurn({ color, ms: this.bots.visible ? null : TURN_MS });
      return;
    }
    if (this.events.length === this.confirmed) return this.setTurn(this.serverTurn);
    if (this.turn?.color === color && !fresh) return;
    const left = this.serverTurn?.ms == null ? TURN_MS : this.serverTurn.ms - (performance.now() - this.serverTurnAt);
    this.setTurn({ color, ms: Math.max(0, Math.min(TURN_MS, left)) });
  }

  // ---------- the bots this app plays (#221) ----------

  /** The server's whole list (a `game` message): this app's events must start with it. */
  private adopt(server: string[]) {
    for (let i = 0; i < server.length; i++) {
      if (i >= this.events.length) this.push(server[i]!);
      else if (this.events[i] !== server[i]) return this.rewind(i, server);
    }
    this.confirmed = server.length;
    this.pump();
  }

  /** The events from `at` on were wrong: `list` replaces them, and the game screen rebuilds. */
  private rewind(at: number, list: string[]) {
    clearTimeout(this.botTimer);
    this.botTimer = undefined;
    this.events = [...list];
    this.confirmed = list.length;
    this.consumed = Math.min(this.consumed, at);
    this.rewinds++;
    const st = this.setup;
    this.state = st ? replayEvents(st.seats, st.first, st.singles, this.events) : null;
    if (st && this.bots && this.draws) this.used = drawsUsed(st.seats, st.first, st.singles, this.events, this.draws.at, this.bots);
    // Someone waiting for the next event gets it now.
    if (this.waiting && this.consumed < this.events.length) {
      const w = this.waiting;
      this.waiting = null;
      w(this.events[this.consumed++]!);
    }
    this.pump();
  }

  private setDraws(dr: Draws) {
    this.draws = { at: dr.at, d: [...dr.d] };
    const st = this.setup;
    this.used = st && this.bots ? drawsUsed(st.seats, st.first, st.singles, this.events, dr.at, this.bots) : 0;
    this.pump();
  }

  /** Plays the bots' next step, after a person's pace, when it's a bot's turn here. */
  private pump() {
    if (!this.bots || this.botTimer || this.status === 'closed' || !this.state) return;
    const s = this.state;
    if (!isLocalBot(s, this.bots)) return this.runEnded();
    const dr = this.draws;
    if (!dr || dr.at > this.confirmed) return; // the run's draws come with the event that starts it
    if (s.phase === 'roll' && dr.d[this.used] === undefined) {
      // Out of draws (a run with many 6s): ask once for more.
      const key = `draws:${dr.at}:${dr.d.length}`;
      if (this.asked !== key) {
        this.asked = key;
        this.send({ t: 'draws', at: dr.at });
      }
      return;
    }
    this.showTurn();
    this.botTimer = setTimeout(() => {
      this.botTimer = undefined;
      if (this.state !== s || this.draws !== dr) return this.pump();
      const step = botStep(s, this.bots!, dr.d, this.used);
      if (!step) return this.pump();
      this.push(step.ev);
      this.pump();
    }, botPace(s, this.bots));
  }

  /** The bots' run ended here. When it ended the game, there's no person to send it with: send it on its own. */
  private runEnded() {
    this.showTurn();
    const s = this.state!;
    if (s.phase !== 'over' || this.events.length <= this.confirmed) return;
    const key = `bots:${this.confirmed}`;
    if (this.asked === key) return;
    this.asked = key;
    this.send({ t: 'bots', seq: this.confirmed, bots: this.events.slice(this.confirmed) });
  }

  /** Seconds left on the current turn's clock, or null (a bot's turn, or none). */
  secondsLeft(): number | null {
    if (!this.turn || this.turn.ms === null) return null;
    return Math.max(0, Math.ceil((this.turn.ms - (performance.now() - this.turnAt)) / 1000));
  }

  private push(ev: string) {
    // The game as it goes, for the bots (a die from the run's draws uses one).
    const s = this.state;
    if (s && s.phase !== 'over' && ev !== STOP_EVENT) {
      if (this.draws && this.events.length >= this.draws.at && s.phase === 'roll' && isLocalBot(s, this.bots)) this.used++;
      try {
        this.state = applyEvent(s, ev);
      } catch {
        this.state = null; // can't follow: the bots wait for the next sync
      }
    }
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

  /** Every event handed out so far, in order (a game screen that lost track rebuilds the game from these). */
  played(): string[] {
    return this.events.slice(0, this.consumed);
  }

  /** Events received but not handed out yet: the game screen hurries its animations when it falls behind. */
  backlog(): number {
    return this.events.length - this.consumed;
  }

  /** Events handed out so far: the sequence number of the next action. */
  get seq(): number {
    return this.consumed;
  }

  /** A chat line (#212): one of QUICK_CHAT or CHAT_EMOJI by index, or free text. The server relays it. */
  say(line: { quick: number } | { emoji: number } | { text: string }) {
    if (this.chat) this.send({ t: 'chat', ...line });
  }

  /** Reports a chat line: member `from` said `text`. */
  report(from: number, text: string) {
    this.send({ t: 'report', from, text });
  }

  send(m: ClientMsg) {
    // The bots' run this app played goes with the person's roll or move (#221).
    if ((m.t === 'roll' || m.t === 'move') && this.events.length > this.confirmed) m = { ...m, seq: this.confirmed, bots: this.events.slice(this.confirmed) };
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
    clearTimeout(this.botTimer);
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
