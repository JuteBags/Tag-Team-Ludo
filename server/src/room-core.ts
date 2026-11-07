// One private room: its lobby, then its game, run by the server. Pure logic with no Cloudflare APIs (room.ts
// wires it to a Durable Object), so tests drive it with a fake clock and fake connections.
//
// The server is the only one that rolls. A die's chances are the app's own dice (dice.ts), with the boost
// tie-break drawn from the game's seed exactly as offline (so the review rebuilds every roll's chances from
// the seed, revealed when the game ends); the face itself is drawn from the server's crypto RNG. Knowing or
// brute-forcing the 32-bit seed therefore never tells anyone the next face.
import { STOP_EVENT, applyEvent, ownerRanking, resign, resignEvent, createGame, diceWeights, isDone, mixSeed, move, moveEvent, positionKey, roll, rollEvent, sampleFace, seeded, type BotLevel, type Color, type GameState, type Rng, type Seat } from '../../src/engine';
import { BOT_MOVE_MS, BOT_ROLL_MS, BOT_VERSION, DRAWS_PER_BOT, botFace, checkBotEvents, firstLegal, isLocalBot, type Draws, type LocalBots } from '../../src/net/localBots';
import { CHAT_EMOJI, CHAT_GAP_MS, CHAT_MAX, GAME_MODES, MAX_NAME, QUICK_CHAT, TURN_MS, cleanChat, ONLINE_LEVELS, PROTOCOL, modeSlots, type GameMode, type ClientMsg, type ErrorCode, type GameSetup, type Member, type RoomOptions, type ChatFeatures, type ServerMsg, type Turn } from '../../src/net/protocol';

/** A person's time to roll or move before the server plays that step for them. */
export { TURN_MS };
/**
 * Timeouts in a row that count as leaving: the person forfeits (RULES.md section K). Before that the server
 * plays the timed-out step (a roll, or the person's first legal move in the engine's fixed order: no picker,
 * #221), so the game doesn't stall.
 */
export const FORFEIT_TIMEOUTS = 3;
/** Disconnected this long without coming back counts as leaving: the person forfeits. */
export const OFFLINE_MS = 60_000;
/** A shown bot's pause before each roll and move (private rooms; the apps play them, localBots.ts). */
export { BOT_ROLL_MS, BOT_MOVE_MS };
/**
 * Ranked bots are played in the apps (#221): the time a run of bot turns may take, per bot still playing, before
 * the next person's own TURN_MS starts. If no app has sent the run by then, the server plays it with each bot's
 * first legal move (it never picks a bot's move).
 */
export const BOT_RUN_MS = 25_000;
/** The most extra draws an app may ask for in one run of bot turns. */
const MAX_MORE_DRAWS = 5;
/** Names for ranked bots: people's names, as anyone might choose. */
export const BOT_NAMES = ['Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Ananya', 'Ishaan', 'Saanvi', 'Arjun', 'Zoya', 'Vivaan', 'Nisha', 'Reyansh', 'Kiara', 'Leo', 'Maya', 'Omar', 'Lina', 'Sam', 'Ava', 'Noah', 'Mia', 'Ethan', 'Sofia'];
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
  /** Chat (#212): a reported line, for review (the server's log). Nothing else from chat is kept anywhere. */
  report?(r: ChatReport): void;
  /** #221: a line for the server's log (an app's bot run that didn't match, or a run the server played itself). */
  log?(entry: Record<string, unknown>): void;
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

/** A reported chat line: the room, who reported it, who said it and what (names as they were in the room). */
export interface ChatReport {
  room: string;
  reporter: string;
  from: string;
  text: string;
  at: number;
}

interface MemberData {
  token: string;
  name: string;
  /** Left: from the lobby, or from the game (they forfeited, or their side was already home). For good. */
  left: boolean;
  /** Timeouts in a row. */
  timeouts: number;
  /** Since when they've had no connection (null: connected). In a game, OFFLINE_MS of it forfeits. */
  offlineSince?: number | null;
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
  /** The event count `deadline` / `botAt` were set at: they stand until the next event (a reconnect can't reset a clock). */
  pendingAt?: number;
  /** Last activity, or when an over room ends. */
  touched: number;
  /** When the lobby's wait ends (LOBBY_MS after the room was made). */
  lobbyEnds: number;
  /** Ranked: the rating its bots play at, and whether the result has been rated. */
  ranked?: { botRating: number; rated: boolean; results?: Record<string, RatedPerson>; botNames?: Partial<Record<Color, string>> };
  /** #221: the bots the apps play (their seed is for moves and pace only; the dice stay the server's). */
  bots?: LocalBots;
  /** #221: the draws for the run of bot turns waiting at event `at`, and how many its rolls have used. */
  run?: { at: number; d: number[]; used: number; more: number } | null;
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
  /** When each token last chatted (not persisted: chat keeps nothing). */
  private chatAt = new Map<string, number>();

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
      // Offline until they connect: a matched person who never comes forfeits after OFFLINE_MS.
      members.push({ token: x.token, name: cleanName(x.name), left: false, timeouts: 0, offlineSince: now, account: x.account });
      return { member: members.length - 1, name: members[members.length - 1]!.name };
    });
    const colors = modeSlots(options.mode, options.pairing).flatMap((x) => x.colors);
    const first = colors[Math.floor(io.random() * colors.length)]!;
    const setup = setupFor(options, people, first, true);
    // Bots that fill a ranked game look like any player (#216): a person's name, not "Bot".
    const taken = new Set(members.map((m) => m.name));
    const botNames: Partial<Record<Color, string>> = {};
    for (const seat of setup.seats.filter((x) => x.bot)) {
      const free = BOT_NAMES.filter((n) => !taken.has(n));
      const name = free[Math.floor(io.random() * free.length)] ?? 'Player';
      taken.add(name);
      botNames[seat.color] = name;
    }
    // The bots are played in the apps (#221), at their own seed; the dice seed stays the server's secret.
    const levels: Partial<Record<Color, BotLevel>> = {};
    for (const seat of setup.seats) if (seat.bot) levels[seat.color] = seat.level ?? 'normal';
    const bots: LocalBots | undefined = Object.keys(levels).length ? { seed: Math.floor(io.random() * 4294967296) >>> 0, levels } : undefined;
    const data: RoomData = { v: 1, code, options, phase: 'playing', members, seed: Math.floor(io.random() * 4294967296) >>> 0, setup, events: [], deadline: null, botAt: null, touched: now, lobbyEnds: now, ranked: { botRating, rated: false, botNames }, ...(bots ? { bots, run: null } : {}) };
    const room = new RoomCore(data, io);
    room.openRun();
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
    // The apps play every game's bots (#221, #226): only an app with the same bots can play.
    if (msg.botVersion !== BOT_VERSION) return 'protocol';
    let m = d.members.find((x) => x.token === token);
    if (!m) {
      if (d.phase !== 'lobby') return 'started';
      if (d.members.length >= capacity(d.options)) return 'full';
      m = { token, name: cleanName(msg.name), left: false, timeouts: 0 };
      d.members.push(m);
    } else if (d.phase === 'lobby') m.name = cleanName(msg.name);
    // Back before their time ran out. Someone who left the game stays out: they can only watch.
    m.offlineSince = null;
    this.online.add(token);
    this.touch();
    this.syncTo(token);
    this.broadcastMembers(token);
    // The current clock stands (schedule keeps it); only the offline forfeit alarm may move.
    this.schedule();
    this.commit();
    return null;
  }

  /** A connection closed (the person may have others; the adapter says when the last one goes). */
  disconnected(token: string) {
    if (!this.online.delete(token)) return;
    const m = this.data.members.find((x) => x.token === token);
    if (m && m.offlineSince == null) m.offlineSince = this.io.now();
    this.broadcastMembers();
    this.schedule();
    this.commit();
  }

  /** The adapter re-registers open connections after the object wakes up. */
  reattach(token: string) {
    this.online.add(token);
    const m = this.data.members.find((x) => x.token === token);
    if (m) m.offlineSince = null;
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
        if (d.phase !== 'playing' || !this.state) return 'not-your-turn';
        if (msg.seq !== d.events.length) return 'stale';
        // The bots' run this app played comes first (#221).
        if (msg.bots?.length) {
          const err = this.takeBots(me, msg.bots, false);
          if (err) return err;
          if (d.phase !== 'playing') return null;
        }
        const s = this.state!;
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
      case 'bots':
        if (d.phase !== 'playing' || !this.state) return 'not-your-turn';
        if (msg.seq !== d.events.length) return 'stale';
        if (!Array.isArray(msg.bots) || !msg.bots.length) return 'bad-message';
        return this.takeBots(me, msg.bots, true);
      case 'draws': {
        const run = d.run;
        // More draws for the run waiting now (a run with many 6s); a few times at most.
        if (!run || !d.bots || msg.at !== run.at || run.more >= MAX_MORE_DRAWS) return null;
        run.more++;
        const extra = this.newDraws(DRAWS_PER_BOT * Object.keys(d.bots.levels).length);
        run.d.push(...extra);
        for (const m of d.members) this.io.send(m.token, { t: 'draws', at: run.at, d: extra });
        this.commit();
        return null;
      }
      case 'mismatch':
        // Another app played the bots' run differently from what the server took: logged for review (#221).
        if (Number.isInteger(msg.seq) && msg.seq >= 0 && msg.seq < d.events.length && typeof msg.ev === 'string')
          this.io.log?.({ type: 'bot-mismatch', room: d.code, member: d.members[me]!.name, account: d.members[me]!.account, seq: msg.seq, server: d.events[msg.seq], app: msg.ev.slice(0, 16) });
        return null;
      case 'chat':
        this.chat(me, msg);
        return null;
      case 'report': {
        const from = d.members[msg.from];
        if (!from || typeof msg.text !== 'string') return 'bad-message';
        this.io.report?.({ room: d.code, reporter: d.members[me]!.name, from: from.name, text: msg.text.slice(0, CHAT_MAX), at: this.io.now() });
        this.io.send(token, { t: 'reported' });
        return null;
      }
      default:
        return 'bad-message';
    }
  }

  /** What this room's chat allows: free text only in private rooms (not Ranked). */
  private chatFeatures(): ChatFeatures {
    return { text: !this.data.setup?.ranked };
  }

  /**
   * A chat line from member `me` (#212), relayed to everyone in the room and kept nowhere: one of QUICK_CHAT or
   * CHAT_EMOJI, or free text (cleanChat) where it's allowed. At most one line per CHAT_GAP_MS each; extra lines
   * and anything else are dropped without a word.
   */
  private chat(me: number, msg: Extract<ClientMsg, { t: 'chat' }>) {
    const d = this.data;
    const m = d.members[me]!;
    if (m.left) return;
    const now = this.io.now();
    if (now - (this.chatAt.get(m.token) ?? -Infinity) < CHAT_GAP_MS) return;
    let line: { quick?: number; emoji?: number; text?: string } | null = null;
    if (Number.isInteger(msg.quick) && msg.quick! >= 0 && msg.quick! < QUICK_CHAT.length) line = { quick: msg.quick };
    else if (Number.isInteger(msg.emoji) && msg.emoji! >= 0 && msg.emoji! < CHAT_EMOJI.length) line = { emoji: msg.emoji };
    else if (this.chatFeatures().text) {
      const text = cleanChat(msg.text);
      if (text) line = { text };
    }
    if (!line) return;
    this.chatAt.set(m.token, now);
    for (const x of d.members) if (!x.left || x === m) this.io.send(x.token, { t: 'chat', from: me, ...line, at: now });
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
    // Someone gone too long forfeits first (it may end the game, or change whose turn it is).
    const gone = d.members.findIndex((m, i) => m.offlineSince != null && now >= m.offlineSince + OFFLINE_MS && this.canForfeit(i));
    if (gone >= 0) return this.forfeit(gone);
    if (d.botAt !== null && now >= d.botAt) this.botStep();
    else if (d.deadline !== null && now >= d.deadline && isLocalBot(this.state!, d.bots)) this.fallbackBots();
    else if (d.deadline !== null && now >= d.deadline) {
      const s = this.state!;
      const who = this.controller(s.players[s.current]!.color);
      const m = d.members[who]!;
      m.timeouts++;
      // Three in a row is leaving; before that, the server plays the step so the game goes on.
      if (m.timeouts >= FORFEIT_TIMEOUTS) this.forfeit(who);
      else this.botStep();
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
    // The bots in the empty seats are played in the apps (#226), at the host's level, shown as bots.
    const levels: Partial<Record<Color, BotLevel>> = {};
    for (const seat of seats) if (seat.bot) levels[seat.color] = seat.level ?? 'normal';
    if (Object.keys(levels).length) {
      d.bots = { seed: Math.floor(this.io.random() * 4294967296) >>> 0, levels, visible: true };
      d.run = null;
      this.openRun();
    }
    // Anyone not connected when it starts is on the offline clock from now.
    const now = this.io.now();
    for (const m of d.members) m.offlineSince = this.online.has(m.token) ? null : now;
    this.schedule();
    for (const m of d.members) this.syncTo(m.token);
    this.commit();
  }

  /**
   * The server plays the current colour: a bot's seat in a private room. Ranked bots are the apps' (#221). (A
   * person's colour is theirs until they forfeit; then it's out of the game.)
   */
  private serverPlays(): boolean {
    const s = this.state!;
    return s.players[s.current]!.bot && !isLocalBot(s, this.data.bots);
  }

  // ---------- bots played in the apps (#221) ----------

  private newDraws(n: number): number[] {
    return Array.from({ length: n }, () => Math.floor(this.io.random() * 4294967296) >>> 0);
  }

  /** The bots the apps play that are still in the game (for the run's time). */
  private botsPlaying(): number {
    const s = this.state!;
    return s.players.filter((p) => this.data.bots?.levels[p.color] !== undefined && !isDone(p) && !s.out?.includes(p.owner)).length;
  }

  /**
   * The draws for the run of bot turns that starts now, when the bots' turn has come: fresh ones for each run
   * (a run's spares are thrown away when it ends; draws are never used twice). Returns the new ones, to send.
   */
  openRun(): Draws | undefined {
    const d = this.data;
    const s = this.state;
    if (!d.bots) return undefined;
    if (d.phase !== 'playing' || !s || !isLocalBot(s, d.bots)) {
      d.run = null;
      return undefined;
    }
    if (d.run && d.run.at === d.events.length) return undefined; // still waiting for this run
    d.run = { at: d.events.length, d: this.newDraws(DRAWS_PER_BOT * Object.keys(d.bots.levels).length), used: 0, more: 0 };
    return { at: d.run.at, d: [...d.run.d] };
  }

  /**
   * A run of bot events from member `me`'s app: checked (each roll against its draw, each move against the rules)
   * and played. `whole`: the run must end the bots' turns (a `bots` message); with a roll or move, the person's
   * own turn follows. A run that doesn't check out is turned down and logged, and the app is sent the game again.
   */
  private takeBots(me: number, evs: string[], whole: boolean): ErrorCode | null {
    const d = this.data;
    const run = d.run;
    const s = this.state!;
    if (!d.bots || !run || run.at !== d.events.length || !isLocalBot(s, d.bots) || !Array.isArray(evs)) return 'illegal';
    const res = checkBotEvents(s, d.bots, run.d, run.used, evs);
    if ('error' in res || (whole && isLocalBot(res.states[res.states.length - 1]!, d.bots))) {
      this.io.log?.({ type: 'bot-run-refused', room: d.code, member: d.members[me]!.name, account: d.members[me]!.account, at: run.at, why: 'error' in res ? res.error : 'the run did not end', events: evs.slice(0, 40) });
      this.syncTo(d.members[me]!.token);
      return 'illegal';
    }
    run.used = res.used;
    this.applyBatch(evs, res.states);
    return null;
  }

  /**
   * Nobody sent the bots' run in time (every app offline, or none on this bot version): the server plays it, with
   * the run's draws and each bot's first legal move. It never picks a move (#221).
   */
  private fallbackBots() {
    const d = this.data;
    if (!d.run) this.openRun();
    const run = d.run!;
    let s = this.state!;
    const evs: string[] = [];
    const states: GameState[] = [];
    while (isLocalBot(s, d.bots) && evs.length < 2000) {
      if (s.phase === 'roll') {
        const draw = run.d[run.used] ?? this.newDraws(1)[0]!;
        run.used++;
        const face = botFace(s, d.bots!, draw);
        evs.push(rollEvent(face));
        s = roll(s, () => 0, face);
      } else {
        const m = firstLegal(s);
        evs.push(moveEvent(m));
        s = move(s, m);
      }
      states.push(s);
    }
    this.io.log?.({ type: 'bot-fallback', room: d.code, at: run.at, events: evs.length });
    this.applyBatch(evs, states);
  }

  /** Several events at once (a bots' run): each goes to everyone, then the usual after-event step for the last. */
  private applyBatch(evs: string[], states: GameState[]) {
    const d = this.data;
    for (let i = 0; i < evs.length; i++) {
      this.apply(evs[i]!, states[i]!);
      if (i === evs.length - 1) break;
      const seq = d.events.length - 1;
      for (const m of d.members) this.io.send(m.token, { t: 'ev', seq, ev: evs[i]!, turn: this.turn() });
    }
    this.afterEvent();
  }

  /** The side member `i` plays (each person plays for one side), or null. */
  private sideOf(i: number): number | null {
    const s = this.state;
    if (!s) return null;
    const p = s.players.find((q) => this.controller(q.color) === i);
    return p ? p.owner : null;
  }

  /**
   * Whether member `i` leaving now would forfeit: in a game still going, their side is still in, and they still
   * have a colour to play (in 2v2, someone whose own colour is home has nothing left to play: no forfeit).
   */
  private canForfeit(i: number): boolean {
    const s = this.state;
    const d = this.data;
    if (d.phase !== 'playing' || !s || s.phase === 'over' || d.members[i]!.left) return false;
    const side = this.sideOf(i);
    if (side === null || s.out?.includes(side)) return false;
    return s.players.some((p) => this.controller(p.color) === i && !isDone(p));
  }

  /**
   * Member `i` leaves the game (Leave game, OFFLINE_MS without a connection, or FORFEIT_TIMEOUTS in a row): their
   * side resigns (a 2v2 team forfeits together). With two sides that ends the game; in 1v1v1v1 the others play on.
   */
  private forfeit(i: number) {
    const d = this.data;
    const m = d.members[i]!;
    const was = this.canForfeit(i);
    m.left = true;
    if (!was) {
      this.broadcastMembers();
      this.schedule();
      this.commit();
      return;
    }
    const side = this.sideOf(i)!;
    this.apply(resignEvent(side), resign(this.state!, side));
    this.broadcastMembers();
    this.afterEvent();
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
    // Sides that forfeited are already last (the engine ranks resigned sides last).
    const order = ownerRanking(s);
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
    const present = (side: number) => !s.out?.includes(side) && s.players.some((q) => q.owner === side && !q.bot && !d.members[this.controller(q.color)]!.left);
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

  /**
   * The server acts for the current colour: a roll, or the first legal move in the engine's fixed order. For a
   * person whose clock ran out (the owner, #221), and for a bot in a room saved before the apps played the bots
   * (#226). The server picks no one's move: there is no rule bot on the server.
   */
  private botStep() {
    const s = this.state!;
    if (s.phase === 'roll') this.rollNow();
    else {
      const m = firstLegal(s);
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
      if (d.bots) d.run = null;
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
    // The bots' turn has come (#221): their run's draws go with this event.
    const draws = this.openRun();
    this.schedule();
    const seq = d.events.length - 1;
    for (const m of d.members) this.io.send(m.token, { t: 'ev', seq, ev: d.events[seq]!, turn: this.turn(), ...(draws ? { draws } : {}) });
    this.commit();
  }

  /**
   * The game's setup as players get it. In a ranked game the bots that filled empty places (#216) are seated like
   * people, with their names: nothing on the screen tells them apart. The server's own setup keeps them as bots.
   */
  private publicSetup(): GameSetup {
    const d = this.data;
    const s = d.setup!;
    if (!d.ranked) return s;
    const names = d.ranked.botNames ?? {};
    const nameOf = (x: Seat) => (x.bot ? (names[x.color] ?? 'Player') : (s.people[s.control[x.color]!] ?? ''));
    const sides = [...new Set(s.seats.map((x) => x.owner))].sort((a, b) => a - b);
    return {
      ...s,
      seats: s.seats.map((x) => (x.bot ? { color: x.color, owner: x.owner, bot: false } : x)),
      names: sides.map((side) => [...new Set(s.seats.filter((x) => x.owner === side).map(nameOf))].join(' & ')),
    };
  }

  private turn(): Turn | null {
    const d = this.data;
    if (d.phase !== 'playing' || !this.state) return null;
    const color = this.state.players[this.state.current]!.color;
    // A ranked bot's turn shows a person's clock (#216).
    if (d.deadline === null && d.ranked && this.state.players[this.state.current]!.bot) return { color, ms: TURN_MS };
    return { color, ms: d.deadline === null ? null : Math.max(0, d.deadline - this.io.now()) };
  }

  /** Sets the next bot step or the person's deadline, and the alarm for it (or for the room's end). */
  private schedule() {
    const d = this.data;
    const now = this.io.now();
    const pending = d.pendingAt === d.events.length && (d.deadline !== null || d.botAt !== null);
    if (d.phase !== 'playing' || !this.state || this.everyoneGone()) d.deadline = d.botAt = null;
    else if (!pending) {
      // A new step: a fresh clock (a reconnect keeps the one running).
      d.deadline = d.botAt = null;
      if (this.serverPlays()) d.botAt = now + (this.state.phase === 'roll' ? BOT_ROLL_MS : BOT_MOVE_MS);
      // The bots' run in the apps (#221): its time, then the next person's.
      else if (isLocalBot(this.state, d.bots)) d.deadline = now + BOT_RUN_MS * this.botsPlaying() + TURN_MS;
      else d.deadline = now + TURN_MS;
      d.pendingAt = d.events.length;
    }
    // The earliest of: the step, someone's offline forfeit, the lobby's end, the room's end.
    const forfeits = d.members.flatMap((m, i) => (m.offlineSince != null && this.canForfeit(i) ? [m.offlineSince + OFFLINE_MS] : []));
    const at = [d.botAt, d.deadline, ...forfeits].filter((x): x is number => x !== null);
    this.io.setAlarm(at.length ? Math.min(...at) : d.phase === 'lobby' ? d.lobbyEnds : d.touched + (d.phase === 'over' ? OVER_MS : IDLE_MS));
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
      this.online.delete(token);
      if (d.phase === 'playing') return this.forfeit(me);
      d.members[me]!.left = true;
      this.broadcastMembers();
    }
    this.commit();
  }

  // ---------- telling people ----------

  members(): Member[] {
    const d = this.data;
    const s = this.state;
    return d.members.map((m, owner) => ({ owner, name: m.name, online: this.online.has(m.token), host: owner === 0, left: d.phase !== 'lobby' && !!s && m.left }));
  }

  private syncTo(token: string) {
    const d = this.data;
    const you = d.members.findIndex((m) => m.token === token);
    if (you < 0) return;
    if (d.phase === 'lobby') this.io.send(token, { t: 'lobby', code: d.code, options: d.options, members: this.members(), you, endsIn: Math.max(0, d.lobbyEnds - this.io.now()), chat: this.chatFeatures() });
    else {
      this.io.send(token, { t: 'game', code: d.code, setup: this.publicSetup(), events: [...d.events], members: this.members(), you, turn: this.turn(), chat: this.chatFeatures(), ...(d.bots ? { bots: d.bots } : {}), ...(d.run ? { draws: { at: d.run.at, d: [...d.run.d] } } : {}) });
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
