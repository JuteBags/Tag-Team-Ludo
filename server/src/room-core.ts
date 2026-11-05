// One private room: its lobby, then its game, run by the server. Pure logic with no Cloudflare APIs (room.ts
// wires it to a Durable Object), so tests drive it with a fake clock and fake connections.
//
// The server is the only one that rolls. A die's chances are the app's own dice (dice.ts), with the boost
// tie-break drawn from the game's seed exactly as offline (so the review rebuilds every roll's chances from
// the seed, revealed when the game ends); the face itself is drawn from the server's crypto RNG. Knowing or
// brute-forcing the 32-bit seed therefore never tells anyone the next face.
import { STOP_EVENT, applyEvent, ownerRanking, createGame, diceWeights, isDone, mixSeed, move, moveEvent, positionKey, roll, rollEvent, sampleFace, seeded, type Color, type GameState, type Rng, type Seat } from '../../src/engine';
import { chooseRuleMove } from '../../src/engine/ai/choose';
import { GAME_MODES, MAX_NAME, ONLINE_LEVELS, PROTOCOL, modeSlots, type GameMode, type ClientMsg, type ErrorCode, type GameSetup, type Member, type RoomOptions, type ServerMsg, type Turn } from '../../src/net/protocol';

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
  /** Ranked: rates the finished game (the accounts store), answering each account's rating before and after. */
  rate?(report: RateReport): Promise<Record<string, RatedPerson>>;
}

/** A finished ranked game for the accounts store: each side's people (accounts) or bots (their rating), by place. */
export interface RateReport {
  mode: GameMode;
  sides: { members: ({ account: string } | { bot: number })[]; place: number }[];
}
export interface RatedPerson {
  before: number;
  after: number;
  games: number;
}

interface MemberData {
  token: string;
  name: string;
  /** Left the game: a bot plays their seat until they come back. */
  left: boolean;
  /** Timeouts in a row. */
  timeouts: number;
  /** Ranked: their account. */
  account?: string;
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
  /** Ranked: the rating its bots play at, and whether the result has been rated. */
  ranked?: { botRating: number; rated: boolean; results?: Record<string, RatedPerson> };
}

export const cleanName = (s: unknown) =>
  (typeof s === 'string' ? s : '').replace(/[\u0000-\u001f\u007f<>&"]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || 'Player';

export const validOptions = (o: Partial<RoomOptions> | undefined): RoomOptions | null =>
  o && GAME_MODES.includes(o.mode!) && (o.pairing === undefined || o.pairing === 'opposite' || o.pairing === 'adjacent') && typeof o.singles === 'boolean' && ONLINE_LEVELS.includes(o.botLevel!)
    ? { mode: o.mode!, pairing: o.pairing ?? 'opposite', singles: o.singles, botLevel: o.botLevel! }
    : null;

/** People a room of these options takes (bots fill the rest when it starts). */
export const capacity = (o: RoomOptions) => modeSlots(o.mode, o.pairing).length;

/**
 * The game's setup for these options: `people` has one entry per slot (modeSlots order), the member index and
 * name of whoever plays it, or null for a bot (also for slots past its end). It gives the seats, who
 * controls each colour, and each side's name ("A & B" for a team of two people).
 */
export function setupFor(o: RoomOptions, people: ({ member: number; name: string } | null)[], first: Color, ranked = false): GameSetup {
  const slots = modeSlots(o.mode, o.pairing);
  const seats: Seat[] = [];
  const control: Partial<Record<Color, number>> = {};
  slots.forEach((slot, i) => {
    const who = people[i] ?? null;
    for (const color of slot.colors) {
      seats.push(who ? { color, owner: slot.side, bot: false } : { color, owner: slot.side, bot: true, level: o.botLevel });
      control[color] = who ? who.member : -1;
    }
  });
  const sides = [...new Set(slots.map((x) => x.side))].sort((a, b) => a - b);
  const sideNames = sides.map((side) => slots.flatMap((x, i) => (x.side === side && people[i] ? [people[i]!.name] : [])).join(' & '));
  const names: string[] = [];
  for (const p of people) if (p) names[p.member] = p.name;
  return { mode: o.mode, seats, first, singles: o.singles, names: sideNames, control, people: names, ...(ranked ? { ranked: true } : {}) };
}

/** A lobby's people: member i plays slot i. */
const lobbyPeople = (names: string[]) => names.map((name, member) => ({ member, name }));

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

  /**
   * A ranked game, matched by the queue: its people are known (each with the token the queue gave them, by
   * slot; null slots are ranked bots at `botRating`), so it starts at once, with no lobby.
   */
  static ranked(code: string, options: RoomOptions, slots: ({ token: string; name: string; account: string } | null)[], botRating: number, io: RoomIO): RoomCore {
    const now = io.now();
    const members: MemberData[] = [];
    const people = slots.map((x) => {
      if (!x) return null;
      members.push({ token: x.token, name: cleanName(x.name), left: false, timeouts: 0, account: x.account });
      return { member: members.length - 1, name: members[members.length - 1]!.name };
    });
    const colors = modeSlots(options.mode, options.pairing).flatMap((x) => x.colors);
    const first = colors[Math.floor(io.random() * colors.length)]!;
    const setup = setupFor(options, people, first, true);
    const data: RoomData = { v: 1, code, options, phase: 'playing', members, seed: Math.floor(io.random() * 4294967296) >>> 0, setup, events: [], deadline: null, botAt: null, touched: now, lobbyEnds: now, ranked: { botRating, rated: false } };
    const room = new RoomCore(data, io);
    room.schedule();
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
      if (d.members.length >= capacity(d.options)) return 'full';
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
        if (this.controller(s.players[s.current]!.color) !== me) return 'not-your-turn';
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
      const m = d.members[this.controller(s.players[s.current]!.color)]!;
      m.timeouts++;
      this.botStep();
    } else if (now >= d.touched + IDLE_MS) return this.io.destroy();
    else this.schedule();
  }

  // ---------- the game ----------

  private start() {
    const d = this.data;
    const colors = modeSlots(d.options.mode, d.options.pairing).flatMap((x) => x.colors);
    const first = colors[Math.floor(this.io.random() * colors.length)]!;
    d.setup = setupFor(d.options, lobbyPeople(d.members.map((m) => m.name)), first);
    const seats = d.setup.seats;
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
    const m = this.data.members[this.controller(p.color)]!;
    return m.left || m.timeouts >= MAX_TIMEOUTS;
  }

  /**
   * Ranked: the result for the accounts store, then each person's rating change. Places are the sides' final
   * ranking, except that a side with a person who left ranks last (leaving is losing).
   */
  async rateGame() {
    const d = this.data;
    if (!d.ranked || d.ranked.rated || !this.io.rate || !this.state || !d.setup) return;
    d.ranked.rated = true;
    this.commit();
    const s = this.state;
    const sides = ownerRanking(s);
    const quit = (side: number) => s.players.some((p) => p.owner === side && !p.bot && d.members[this.controller(p.color)]!.left);
    const order = [...sides.filter((x) => !quit(x)), ...sides.filter(quit)];
    const report: RateReport = {
      mode: d.options.mode,
      sides: order.map((side, place) => {
        const members: RateReport['sides'][number]['members'] = [];
        const seen = new Set<number>();
        for (const p of s.players.filter((q) => q.owner === side)) {
          const who = this.controller(p.color);
          if (who < 0) members.push({ bot: d.ranked!.botRating });
          else if (!seen.has(who)) {
            seen.add(who);
            members.push({ account: d.members[who]!.account! });
          }
        }
        return { members, place };
      }),
    };
    let rated: Record<string, RatedPerson>;
    try {
      rated = await this.io.rate(report);
    } catch {
      return; // The store couldn't be reached: the game stands, unrated.
    }
    d.ranked!.results = rated;
    this.commit();
    for (const m of d.members) {
      const r = m.account ? rated[m.account] : undefined;
      if (r) this.io.send(m.token, { t: 'rated', mode: d.options.mode, before: r.before, after: r.after, games: r.games });
    }
  }

  /** The member (slot) who plays `c`, or -1 for a bot. */
  private controller(c: Color): number {
    return this.data.setup?.control[c] ?? -1;
  }

  /**
   * A side with a person still in it (not left) hasn't finished: the game goes on. With only bots' sides (or
   * finished ones) left, nobody is watching for the rest of the places.
   */
  private peopleStillPlaying(): boolean {
    const s = this.state!;
    const d = this.data;
    const present = (side: number) => s.players.some((q) => q.owner === side && !q.bot && !d.members[this.controller(q.color)]!.left);
    const done = (side: number) => s.players.filter((q) => q.owner === side).every(isDone);
    return s.players.some((p) => present(p.owner) && !done(p.owner));
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
    const stopped = s.phase !== 'over' && !this.peopleStillPlaying();
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
      void this.rateGame();
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
        if (!this.peopleStillPlaying()) {
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
          void this.rateGame();
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
      if (d.phase === 'over') {
        this.io.send(token, { t: 'over', seed: d.seed!, stopped: d.events[d.events.length - 1] === STOP_EVENT });
        // Ranked: the rating change, for a phone that missed it.
        const account = d.members[you]!.account;
        const r = account ? d.ranked?.results?.[account] : undefined;
        if (r) this.io.send(token, { t: 'rated', mode: d.options.mode, before: r.before, after: r.after, games: r.games });
      }
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
