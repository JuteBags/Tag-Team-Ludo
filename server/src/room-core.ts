// One private room: its lobby, then its game, run by the server. Pure logic with no Cloudflare APIs (room.ts
// wires it to a Durable Object), so tests drive it with a fake clock and fake connections.
//
// The server is the only one that rolls. A die's chances are the app's own dice (dice.ts), with the boost
// tie-break drawn from the game's seed exactly as offline (so the review rebuilds every roll's chances from
// the seed, revealed when the game ends); the face itself is drawn from the server's crypto RNG. Knowing or
// brute-forcing the 32-bit seed therefore never tells anyone the next face.
import { SEATS, STOP_EVENT, applyEvent, createGame, diceWeights, isDone, mixSeed, move, moveEvent, positionKey, roll, rollEvent, sampleFace, seeded, type GameState, type Rng, type Seat } from '../../src/engine';
import { chooseRuleMove } from '../../src/engine/ai/choose';
import { MAX_NAME, ONLINE_LEVELS, PROTOCOL, type ClientMsg, type ErrorCode, type GameSetup, type Member, type RoomOptions, type ServerMsg, type Turn } from '../../src/net/protocol';

/** A person's time to roll or move before the server plays for them. */
export const TURN_MS = 30_000;
/** Timeouts in a row before a bot plays for that person until they act again. */
export const MAX_TIMEOUTS = 2;
/** The pause before each bot roll and bot move, so everyone can follow the bots. */
export const BOT_ROLL_MS = 900;
export const BOT_MOVE_MS = 1100;
/** A room nobody touches for this long is deleted (lobby or game). */
export const IDLE_MS = 2 * 60 * 60_000;
/** A finished room stays this long, so everyone can still get its result. */
export const OVER_MS = 30 * 60_000;
/**
 * How long a lobby waits. Then the game starts by itself with bots in the empty seats, or, with nobody
 * but the host in, the room closes. The host can start earlier.
 */
export const LOBBY_MS = 2 * 60_000;
/** People needed to start (bots fill the rest of the seats). */
export const MIN_PEOPLE = 2;

/** What the room needs from the outside world. */
export interface RoomIO {
  now(): number;
  /** To every connection of this person. */
  send(token: string, msg: ServerMsg): void;
  /** When alarm() should run next (null: never). */
  setAlarm(at: number | null): void;
  /** Persist the room (called after every change). */
  save(data: RoomData): void;
  /** Forget the room entirely and close its connections. */
  destroy(): void;
  /** Uniform in [0, 1) from a CSPRNG (the faces) and a 32-bit random seed. */
  random: Rng;
}

interface MemberData {
  token: string;
  name: string;
  /** Left the game: a bot plays their seat until they come back. */
  left: boolean;
  /** Timeouts in a row. */
  timeouts: number;
}

/** Everything the room keeps between wake-ups. The game state is rebuilt from `events`. */
export interface RoomData {
  v: 1;
  code: string;
  options: RoomOptions;
  phase: 'lobby' | 'playing' | 'over';
  members: MemberData[];
  seed: number | null;
  setup: GameSetup | null;
  events: string[];
  /** When the current person's time runs out, or when the next bot step is due (both null: nothing pending). */
  deadline: number | null;
  botAt: number | null;
  /** Last activity, or when an over room ends. */
  touched: number;
  /** When the lobby's wait ends (LOBBY_MS after the room was made). */
  lobbyEnds: number;
}

export const cleanName = (s: unknown) =>
  (typeof s === 'string' ? s : '').replace(/[\u0000-\u001f\u007f<>&"]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || 'Player';

export const validOptions = (o: Partial<RoomOptions> | undefined): RoomOptions | null =>
  o && (o.players === 2 || o.players === 3 || o.players === 4) && typeof o.singles === 'boolean' && ONLINE_LEVELS.includes(o.botLevel!)
    ? { players: o.players, singles: o.singles, botLevel: o.botLevel! }
    : null;

export class RoomCore {
  private state: GameState | null = null;
  /** Tokens with a connection open now (not persisted: the adapter re-adds them on wake). */
  private online = new Set<string>();

  constructor(private data: RoomData, private io: RoomIO) {
    if (data.setup) this.state = rebuild(data.setup, data.events);
  }

  static create(code: string, options: RoomOptions, io: RoomIO): RoomCore {
    const room = new RoomCore({ v: 1, code, options, phase: 'lobby', members: [], seed: null, setup: null, events: [], deadline: null, botAt: null, touched: io.now(), lobbyEnds: io.now() + LOBBY_MS }, io);
    room.commit();
    return room;
  }

  get snapshot(): Readonly<RoomData> {
    return this.data;
  }

  // ---------- connections ----------

  /** A connection said hello. Returns an error to close it with, or null when it's in the room. */
  hello(token: string, msg: Extract<ClientMsg, { t: 'hello' }>): ErrorCode | null {
    if (msg.protocol !== PROTOCOL) return 'protocol';
    const d = this.data;
    let m = d.members.find((x) => x.token === token);
    if (!m) {
      if (d.phase !== 'lobby') return 'started';
      if (d.members.length >= d.options.players) return 'full';
      m = { token, name: cleanName(msg.name), left: false, timeouts: 0 };
      d.members.push(m);
    } else if (d.phase === 'lobby') m.name = cleanName(msg.name);
    // Back in the game: no more bot for them.
    m.left = false;
    m.timeouts = 0;
    this.online.add(token);
    this.touch();
    this.syncTo(token);
    this.broadcastMembers(token);
    // Their seat may have been waiting on a bot step; it's theirs again now.
    this.schedule();
    this.commit();
    return null;
  }

  /** A connection closed (the person may have others; the adapter says when the last one goes). */
  disconnected(token: string) {
    if (!this.online.delete(token)) return;
    this.broadcastMembers();
  }

  /** The adapter re-registers open connections after the object wakes up. */
  reattach(token: string) {
    this.online.add(token);
  }

  // ---------- messages ----------

  /** A message from a connection that said hello. Returns an error for that connection, or null. */
  async handle(token: string, msg: ClientMsg): Promise<ErrorCode | null> {
    const d = this.data;
    const me = d.members.findIndex((x) => x.token === token);
    if (me < 0) return 'bad-message';
    this.touch();
    switch (msg.t) {
      case 'ping':
        this.io.send(token, { t: 'pong' });
        return null;
      case 'start':
        if (d.phase !== 'lobby') return 'started';
        if (me !== 0) return 'not-host';
        if (d.members.length < MIN_PEOPLE) return 'not-enough';
        this.start();
        return null;
      case 'leave':
        this.leave(me);
        return null;
      case 'roll':
      case 'move': {
        const s = this.state;
        if (d.phase !== 'playing' || !s) return 'not-your-turn';
        if (msg.seq !== d.events.length) return 'stale';
        if (s.players[s.current]!.owner !== me || s.players[s.current]!.bot) return 'not-your-turn';
        if (msg.t === 'roll') {
          if (s.phase !== 'roll') return 'illegal';
          d.members[me]!.timeouts = 0;
          this.rollNow();
        } else {
          if (s.phase !== 'move' || typeof msg.ev !== 'string') return 'illegal';
          const m = s.moves.find((x) => moveEvent(x) === msg.ev);
          if (!m) return 'illegal';
          d.members[me]!.timeouts = 0;
          this.apply(moveEvent(m), move(s, m));
        }
        this.afterEvent();
        return null;
      }
      default:
        return 'bad-message';
    }
  }

  // ---------- the clock ----------

  /** Runs whatever is due: a bot step, a timed-out turn, or the room's end. */
  alarm() {
    const d = this.data;
    const now = this.io.now();
    if (d.phase === 'lobby' && now >= d.lobbyEnds) {
      if (d.members.length >= MIN_PEOPLE) return this.start();
      // Nobody joined in time: the room closes.
      for (const m of d.members) this.io.send(m.token, { t: 'error', code: 'expired', message: 'Nobody joined in time, so the room closed.' });
      return this.io.destroy();
    }
    if (d.phase === 'over' || d.phase === 'lobby' || this.everyoneGone()) {
      if (now >= d.touched + (d.phase === 'over' ? OVER_MS : IDLE_MS)) return this.io.destroy();
      return this.schedule();
    }
    if (d.botAt !== null && now >= d.botAt) this.botStep();
    else if (d.deadline !== null && now >= d.deadline) {
      const s = this.state!;
      const m = d.members[s.players[s.current]!.owner]!;
      m.timeouts++;
      this.botStep();
    } else if (now >= d.touched + IDLE_MS) return this.io.destroy();
    else this.schedule();
  }

  // ---------- the game ----------

  private start() {
    const d = this.data;
    const people = d.members.length;
    const seats: Seat[] = SEATS[d.options.players].map((color, owner) =>
      owner < people ? { color, owner, bot: false } : { color, owner, bot: true, level: d.options.botLevel },
    );
    const first = seats[Math.floor(this.io.random() * seats.length)]!.color;
    d.setup = { seats, first, singles: d.options.singles, names: seats.map((s) => (s.bot ? '' : d.members[s.owner]!.name)) };
    d.seed = Math.floor(this.io.random() * 4294967296) >>> 0;
    d.events = [];
    d.phase = 'playing';
    this.state = createGame(seats, first, d.options.singles);
    this.schedule();
    for (const m of d.members) this.syncTo(m.token);
    this.commit();
  }

  /** Who plays the current colour now: a person, or the server (a bot seat, or a person who left or timed out too often). */
  private serverPlays(): boolean {
    const s = this.state!;
    const p = s.players[s.current]!;
    if (p.bot) return true;
    const m = this.data.members[p.owner]!;
    return m.left || m.timeouts >= MAX_TIMEOUTS;
  }

  private rollNow() {
    const s = this.state!;
    const p = s.players[s.current]!;
    // The app's dice, with the tie-break from the seed (so the review can rebuild the chances), and the face from the CSPRNG.
    const weights = diceWeights(s.players, p.color, seeded(mixSeed(this.data.seed!, 'dice' + positionKey(s))), s.singles);
    const after = roll(s, () => 0, sampleFace(weights, this.io.random));
    this.apply(rollEvent(after.dice!), after);
  }

  /** The server acts for the current colour: a roll, or the rule bot's move (Normal for a person it stands in for). */
  private botStep() {
    const s = this.state!;
    if (s.phase === 'roll') this.rollNow();
    else {
      const p = s.players[s.current]!;
      const m = chooseRuleMove(s, seeded(mixSeed(this.data.seed!, 'bot' + positionKey(s))), p.bot ? (p.level ?? 'normal') : 'normal');
      this.apply(moveEvent(m), move(s, m));
    }
    this.afterEvent();
  }

  private apply(ev: string, next: GameState) {
    this.data.events.push(ev);
    this.state = next;
  }

  private afterEvent() {
    const d = this.data;
    const s = this.state!;
    // Every person is done (or gone) and only bots still play: the game ends with the places as they stand.
    const stopped = s.phase !== 'over' && !s.players.some((p) => !p.bot && !isDone(p) && !d.members[p.owner]!.left);
    if (s.phase === 'over' || stopped) {
      d.phase = 'over';
      d.deadline = d.botAt = null;
      if (stopped) d.events.push(STOP_EVENT);
      d.touched = this.io.now();
      const seq = d.events.length - 1;
      // The last event (or the stop marker), then the result.
      for (const m of d.members) {
        this.io.send(m.token, { t: 'ev', seq, ev: d.events[seq]!, turn: null });
        this.io.send(m.token, { t: 'over', seed: d.seed!, stopped });
      }
      this.schedule();
      this.commit();
      return;
    }
    this.schedule();
    const seq = d.events.length - 1;
    for (const m of d.members) this.io.send(m.token, { t: 'ev', seq, ev: d.events[seq]!, turn: this.turn() });
    this.commit();
  }

  private turn(): Turn | null {
    const d = this.data;
    if (d.phase !== 'playing' || !this.state) return null;
    const color = this.state.players[this.state.current]!.color;
    return { color, ms: d.deadline === null ? null : Math.max(0, d.deadline - this.io.now()) };
  }

  /** Sets the next bot step or the person's deadline, and the alarm for it (or for the room's end). */
  private schedule() {
    const d = this.data;
    const now = this.io.now();
    d.deadline = d.botAt = null;
    if (d.phase === 'playing' && this.state && !this.everyoneGone()) {
      if (this.serverPlays()) d.botAt = now + (this.state.phase === 'roll' ? BOT_ROLL_MS : BOT_MOVE_MS);
      else d.deadline = now + TURN_MS;
    }
    this.io.setAlarm(d.botAt ?? d.deadline ?? (d.phase === 'lobby' ? d.lobbyEnds : d.touched + (d.phase === 'over' ? OVER_MS : IDLE_MS)));
  }

  /** Nobody is connected and every person left: the game waits (and is deleted when idle) instead of bots playing to an empty room. */
  private everyoneGone() {
    return this.online.size === 0 && this.data.members.every((m) => m.left);
  }

  private leave(me: number) {
    const d = this.data;
    const token = d.members[me]!.token;
    if (d.phase === 'lobby') {
      d.members.splice(me, 1);
      this.online.delete(token);
      if (!d.members.length) return this.io.destroy();
      // Seats follow the join order: everyone after moves up one (the next one becomes host if the host left).
      for (const m of d.members) this.syncTo(m.token);
    } else {
      d.members[me]!.left = true;
      this.online.delete(token);
      if (d.phase === 'playing') {
        const s = this.state!;
        const stillPeople = s.players.some((p) => !p.bot && !isDone(p) && !d.members[p.owner]!.left);
        if (!stillPeople) {
          // The last person still playing left: the game ends here.
          d.events.push(STOP_EVENT);
          d.phase = 'over';
          d.deadline = d.botAt = null;
          d.touched = this.io.now();
          const seq = d.events.length - 1;
          for (const m of d.members) {
            this.io.send(m.token, { t: 'ev', seq, ev: STOP_EVENT, turn: null });
            this.io.send(m.token, { t: 'over', seed: d.seed!, stopped: true });
          }
        }
        this.schedule();
      }
      this.broadcastMembers();
    }
    this.commit();
  }

  // ---------- telling people ----------

  members(): Member[] {
    const d = this.data;
    const s = this.state;
    return d.members.map((m, owner) => ({ owner, name: m.name, online: this.online.has(m.token), host: owner === 0, auto: d.phase === 'playing' && !!s && (m.left || m.timeouts >= MAX_TIMEOUTS) }));
  }

  private syncTo(token: string) {
    const d = this.data;
    const you = d.members.findIndex((m) => m.token === token);
    if (you < 0) return;
    if (d.phase === 'lobby') this.io.send(token, { t: 'lobby', code: d.code, options: d.options, members: this.members(), you, endsIn: Math.max(0, d.lobbyEnds - this.io.now()) });
    else {
      this.io.send(token, { t: 'game', code: d.code, setup: d.setup!, events: [...d.events], members: this.members(), you, turn: this.turn() });
      if (d.phase === 'over') this.io.send(token, { t: 'over', seed: d.seed!, stopped: d.events[d.events.length - 1] === STOP_EVENT });
    }
  }

  private broadcastMembers(except?: string) {
    const d = this.data;
    for (const m of d.members) {
      if (m.token === except) continue;
      if (d.phase === 'lobby') this.syncTo(m.token);
      else this.io.send(m.token, { t: 'members', members: this.members() });
    }
  }

  private touch() {
    if (this.data.phase !== 'over') this.data.touched = this.io.now();
  }

  private commit() {
    this.io.save(this.data);
  }
}

/** The game from its setup and events (all already checked when they were played). */
export function rebuild(setup: GameSetup, events: string[]): GameState {
  let s = createGame(setup.seats, setup.first, setup.singles);
  for (const ev of events) {
    if (ev === STOP_EVENT) break;
    s = applyEvent(s, ev);
  }
  return s;
}
