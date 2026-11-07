// The online room (server/src/room-core.ts) with a fake clock and fake phones: each phone keeps the game the
// way the app will, by applying the server's events with the engine, and plays a legal move on its turn.
import { describe, expect, it, vi } from 'vitest';

// #221: counts the rule-bot picks made while the server acts (it must make none for ranked bots or timeouts).
const picks = vi.hoisted(() => ({ server: false, count: 0 }));
vi.mock('../src/engine/ai/choose', async (orig) => {
  const m = await orig<typeof import('../src/engine/ai/choose')>();
  return { ...m, chooseRuleMove: (...a: Parameters<typeof m.chooseRuleMove>) => (picks.server && picks.count++, m.chooseRuleMove(...a)) };
});
import { STOP_EVENT, applyEvent, createGame, moveEvent, ownerRanking, replay, seeded, type GameState } from '../src/engine';
import { PROTOCOL, type ClientMsg, type GameSetup, type RoomOptions, type ServerMsg } from '../src/net/protocol';
import { BOT_VERSION, botStep, isLocalBot, type Draws, type LocalBots } from '../src/net/localBots';
import { BOT_NAMES, LOBBY_MS, OVER_MS, RoomCore, rebuild, setupFor, type RateReport, TURN_MS, type RoomData, type RoomIO } from '../server/src/room-core';
import { testHooksAllowed } from '../server/src/test-hooks';

const OPTS: RoomOptions = { mode: 'ffa', pairing: 'opposite', singles: false, botLevel: 'normal' };
const ppl = (names: string[]) => names.map((name, member) => ({ member, name }));
const tok = (i: number) => i.toString(16).padStart(32, '0');

/** A fake world: a clock, the alarm, and every message each person got. */
function world(seed = 1) {
  const rng = seeded(seed);
  const w = {
    t: 1_000_000,
    alarm: null as number | null,
    saved: null as RoomData | null,
    destroyed: false,
    inbox: new Map<string, ServerMsg[]>(),
    io: null as unknown as RoomIO,
  };
  w.io = {
    now: () => w.t,
    send: (token, msg) => w.inbox.set(token, [...(w.inbox.get(token) ?? []), msg]),
    setAlarm: (at) => (w.alarm = at),
    save: (d) => (w.saved = structuredClone(d)),
    destroy: () => (w.destroyed = true),
    random: rng,
  };
  return w;
}

/** A phone: follows the room's messages like the app does. */
class Phone {
  state: GameState | null = null;
  setup: GameSetup | null = null;
  events: string[] = [];
  you = -1;
  over: Extract<ServerMsg, { t: 'over' }> | null = null;
  lobby: Extract<ServerMsg, { t: 'lobby' }> | null = null;
  errors: string[] = [];
  rated: Extract<ServerMsg, { t: 'rated' }> | null = null;
  /** #221: the bots this phone plays, and the draws of their run waiting now. */
  bots: LocalBots | null = null;
  draws: Draws | null = null;
  /** A modified app (#221): plays this move for a bot instead of the bot's own (null: honest). */
  cheat: ((s: GameState) => string | null) | null = null;
  private read = 0;
  constructor(readonly token: string, private w: ReturnType<typeof world>) {}

  /** Applies every message received since the last call. */
  sync() {
    const box = this.w.inbox.get(this.token) ?? [];
    for (; this.read < box.length; this.read++) {
      const m = box[this.read]!;
      if (m.t === 'lobby') {
        this.lobby = m;
        this.you = m.you;
      } else if (m.t === 'game') {
        this.you = m.you;
        this.setup = m.setup;
        this.events = [...m.events];
        this.state = createGame(m.setup.seats, m.setup.first, m.setup.singles);
        for (const ev of m.events) if (ev !== STOP_EVENT) this.state = applyEvent(this.state, ev);
        this.bots = m.bots ?? null;
        this.draws = m.draws ? { at: m.draws.at, d: [...m.draws.d] } : null;
      } else if (m.t === 'ev') {
        expect(m.seq).toBe(this.events.length); // no gaps, no repeats
        this.events.push(m.ev);
        if (m.ev !== STOP_EVENT) this.state = applyEvent(this.state!, m.ev);
        if (m.draws) this.draws = { at: m.draws.at, d: [...m.draws.d] };
      } else if (m.t === 'draws') {
        if (this.draws?.at === m.at) this.draws.d.push(...m.d);
      } else if (m.t === 'over') this.over = m;
      else if (m.t === 'rated') this.rated = m;
      else if (m.t === 'error') this.errors.push(m.code);
    }
  }

  /**
   * #221: the bots' run this phone plays from the server's game (at once here; the app takes a person's time per
   * step), and the game after it. `out`: the run needs more draws than it has.
   */
  local(): { state: GameState; bots: string[]; out: boolean } {
    let s = this.state!;
    const bots: string[] = [];
    const dr = this.draws;
    if (!this.bots || !dr || dr.at !== this.events.length) return { state: s, bots, out: isLocalBot(s, this.bots) };
    let used = 0;
    while (isLocalBot(s, this.bots)) {
      const cheat = s.phase === 'move' ? this.cheat?.(s) : null;
      if (cheat) {
        bots.push(cheat);
        s = applyEvent(s, cheat);
        continue;
      }
      const step = botStep(s, this.bots, dr.d, used);
      if (!step) return { state: s, bots, out: true };
      bots.push(step.ev);
      s = step.next;
      used = step.used;
    }
    return { state: s, bots, out: false };
  }

  myTurn() {
    if (!this.state || this.over) return false;
    const s = this.local().state;
    return s.phase !== 'over' && this.setup!.control[s.players[s.current]!.color] === this.you;
  }

  /** What this phone would send on its turn: a roll, or a random legal move, after the bots' run it played (#221). */
  action(rng: () => number): ClientMsg {
    const { state: s, bots } = this.local();
    const extra = bots.length ? { bots } : {};
    if (s.phase === 'roll') return { t: 'roll', seq: this.events.length, ...extra };
    return { t: 'move', seq: this.events.length, ev: moveEvent(s.moves[Math.floor(rng() * s.moves.length)]!), ...extra };
  }
}

const hello = (i: number, name = `P${i}`): Extract<ClientMsg, { t: 'hello' }> => ({ t: 'hello', protocol: PROTOCOL, token: tok(i), name, botVersion: BOT_VERSION });

/** Plays the game out: phones act on their turn, otherwise the clock jumps to the room's alarm. */
async function playOut(room: RoomCore, w: ReturnType<typeof world>, phones: Phone[], rng: () => number, skip = new Set<number>()) {
  for (let step = 0; step < 20_000; step++) {
    phones.forEach((p) => p.sync());
    if (phones.every((p) => p.over)) return;
    const mover = phones.find((p, i) => !skip.has(i) && p.myTurn());
    if (mover) {
      expect(await room.handle(mover.token, mover.action(rng))).toBeNull();
      continue;
    }
    // #221: a bots' run that ends the game goes on its own; a run out of draws asks for more.
    const ender = phones.find((p, i) => !skip.has(i) && p.state && !p.over && p.local().bots.length && p.local().state.phase === 'over');
    if (ender) {
      expect(await room.handle(ender.token, { t: 'bots', seq: ender.events.length, bots: ender.local().bots })).toBeNull();
      continue;
    }
    const short = phones.find((p, i) => !skip.has(i) && p.state && !p.over && p.local().out && p.draws);
    if (short && (w.inbox.get(short.token) ?? []).filter((m) => m.t === 'draws').length < 5) {
      expect(await room.handle(short.token, { t: 'draws', at: short.draws!.at })).toBeNull();
      continue;
    }
    expect(w.alarm).not.toBeNull();
    w.t = Math.max(w.t, w.alarm!);
    room.alarm();
  }
  throw new Error('game did not end');
}

describe('online room: lobby', () => {
  it('takes people up to the seats, and only the host starts, with two people or more', async () => {
    const w = world();
    const room = RoomCore.create('ABCDE', { ...OPTS, mode: '1v1' }, w.io);
    expect(room.hello(tok(1), hello(1))).toBeNull();
    expect(await room.handle(tok(1), { t: 'start' })).toBe('not-enough');
    expect(room.hello(tok(2), hello(2))).toBeNull();
    expect(room.hello(tok(3), hello(3))).toBe('full');
    expect(await room.handle(tok(2), { t: 'start' })).toBe('not-host');
    const p1 = new Phone(tok(1), w);
    p1.sync();
    expect(p1.lobby!.members.map((m) => [m.name, m.host, m.online])).toEqual([['P1', true, true], ['P2', false, true]]);
    expect(await room.handle(tok(1), { t: 'start' })).toBeNull();
    expect(room.hello(tok(3), hello(3))).toBe('started');
  });

  it('starts by itself with bots when the lobby wait ends, or closes when nobody joined', async () => {
    const w = world();
    const room = RoomCore.create('ABCDE', OPTS, w.io);
    room.hello(tok(1), hello(1));
    room.hello(tok(2), hello(2));
    const p1 = new Phone(tok(1), w);
    p1.sync();
    expect(p1.lobby!.endsIn).toBe(LOBBY_MS);
    expect(w.alarm).toBe(w.t + LOBBY_MS);
    w.t += LOBBY_MS - 1;
    room.alarm();
    expect(room.snapshot.phase).toBe('lobby');
    w.t += 1;
    room.alarm();
    expect(room.snapshot.phase).toBe('playing');
    expect(room.snapshot.setup!.seats.filter((s) => s.bot)).toHaveLength(2);

    const w2 = world();
    const alone = RoomCore.create('FGHJK', OPTS, w2.io);
    alone.hello(tok(1), hello(1));
    w2.t += LOBBY_MS;
    alone.alarm();
    expect(w2.destroyed).toBe(true);
    expect(w2.inbox.get(tok(1))!.at(-1)).toMatchObject({ t: 'error', code: 'expired' });
  });

  it('turns down another protocol version, and cleans names', () => {
    const w = world();
    const room = RoomCore.create('ABCDE', OPTS, w.io);
    expect(room.hello(tok(1), { ...hello(1), protocol: PROTOCOL + 1 })).toBe('protocol');
    expect(room.hello(tok(1), hello(1, '  <b>Asha</b>   the great one!!  '))).toBeNull();
    expect(room.members()[0]!.name).toBe('bAsha/b the grea');
  });

  it('frees a seat when someone leaves the lobby, and the next person becomes host', async () => {
    const w = world();
    const room = RoomCore.create('ABCDE', OPTS, w.io);
    room.hello(tok(1), hello(1));
    room.hello(tok(2), hello(2));
    await room.handle(tok(1), { t: 'leave' });
    expect(room.members().map((m) => [m.name, m.host])).toEqual([['P2', true]]);
    await room.handle(tok(2), { t: 'leave' });
    expect(w.destroyed).toBe(true);
  });
});

describe('online room: a game', () => {
  for (const [label, opts, people] of [
    ['4 houses, 2 people + 2 bots', OPTS, 2],
    ['1v1, no doubles', { ...OPTS, mode: '1v1', singles: true }, 2],
    ['1(x2) v 1(x2), side by side, hard bots', { ...OPTS, mode: 'duo', pairing: 'adjacent', botLevel: 'hard' }, 2],
    ['2v2, 4 people', { ...OPTS, mode: '2v2' }, 4],
    ['2v2, 3 people and a bot partner', { ...OPTS, mode: '2v2', botLevel: 'easy' }, 3],
  ] as [string, RoomOptions, number][]) {
    it(`plays to the end: ${label}`, async () => {
      for (let seed = 1; seed <= 3; seed++) {
        const w = world(seed);
        const room = RoomCore.create('ABCDE', opts, w.io);
        const phones = Array.from({ length: people }, (_, i) => new Phone(tok(i + 1), w));
        phones.forEach((p, i) => room.hello(p.token, hello(i + 1)));
        await room.handle(tok(1), { t: 'start' });
        await playOut(room, w, phones, seeded(seed * 77));
        const events = room.snapshot.events;
        // Every phone saw exactly the server's game, and it replays as a record (with the revealed seed).
        for (const p of phones) {
          expect(p.events).toEqual(events);
          expect(p.over!.seed).toBe(room.snapshot.seed);
        }
        const setup = room.snapshot.setup!;
        const r = replay({ v: 1, seats: setup.seats, first: setup.first, singles: setup.singles, seed: phones[0]!.over!.seed, events: events.join('') });
        expect(r.ok).toBe(true);
        expect(setup.seats.filter((s) => s.bot).every((s) => s.level === opts.botLevel)).toBe(true);
      }
    });
  }

  it('seats the modes: 2v2 partners opposite on one side, duo two colours each, bots in empty slots', () => {
    const t = setupFor({ ...OPTS, mode: '2v2' }, ppl(['Asha', 'Bilal', 'Chen']), 'blue');
    expect(t.seats.map((s) => [s.color, s.owner, s.bot])).toEqual([['blue', 0, false], ['green', 1, false], ['red', 0, false], ['yellow', 1, true]]);
    expect(t.control).toEqual({ blue: 0, green: 1, red: 2, yellow: -1 });
    expect(t.names).toEqual(['Asha & Chen', 'Bilal']);
    const d = setupFor({ ...OPTS, mode: 'duo', pairing: 'adjacent' }, ppl(['Asha']), 'blue');
    expect(d.seats.map((s) => [s.color, s.owner, s.bot])).toEqual([['blue', 0, false], ['yellow', 0, false], ['green', 1, true], ['red', 1, true]]);
    expect(setupFor({ ...OPTS, mode: '1v1' }, ppl(['A', 'B']), 'red').seats.map((s) => s.color)).toEqual(['blue', 'red']);
    // Every mode's setup is a valid game record setup.
    for (const mode of ['ffa', '1v1', 'duo', '2v2'] as const) {
      const s = setupFor({ ...OPTS, mode }, ppl(['A', 'B']), 'blue');
      expect(replay({ v: 1, seats: s.seats, first: s.first, events: '' }).ok).toBe(true);
    }
  });

  it('turns down stale, out-of-turn and illegal actions', async () => {
    const w = world(5);
    const room = RoomCore.create('ABCDE', { ...OPTS, mode: '1v1' }, w.io);
    room.hello(tok(1), hello(1));
    room.hello(tok(2), hello(2));
    await room.handle(tok(1), { t: 'start' });
    const phones = [new Phone(tok(1), w), new Phone(tok(2), w)];
    phones.forEach((p) => p.sync());
    const mover = phones.find((p) => p.myTurn())!;
    const other = phones.find((p) => p !== mover)!;
    expect(await room.handle(other.token, { t: 'roll', seq: 0 })).toBe('not-your-turn');
    expect(await room.handle(mover.token, { t: 'roll', seq: 3 })).toBe('stale');
    expect(await room.handle(mover.token, { t: 'move', seq: 0, ev: 'a6' })).toBe('illegal');
    expect(await room.handle(mover.token, { t: 'roll', seq: 0 })).toBeNull();
    // The same tap again (a double tap) is stale now.
    expect(await room.handle(mover.token, { t: 'roll', seq: 0 })).toBe('stale');
  });

  /** A started room of `opts` with people 1..n connected, and their phones. */
  async function started(opts: RoomOptions, n: number, seed: number) {
    const w = world(seed);
    const room = RoomCore.create('ABCDE', opts, w.io);
    for (let i = 1; i <= n; i++) room.hello(tok(i), hello(i));
    await room.handle(tok(1), { t: 'start' });
    const phones = Array.from({ length: n }, (_, i) => new Phone(tok(i + 1), w));
    phones.forEach((p) => p.sync());
    return { w, room, phones };
  }

  it('plays the step for someone whose time runs out, twice; the third time in a row they forfeit', async () => {
    const { w, room, phones } = await started({ ...OPTS, mode: '1v1' }, 2, 9);
    const idle = phones.findIndex((p) => p.myTurn());
    const side = room.snapshot.setup!.seats.find((s) => room.snapshot.setup!.control[s.color] === idle)!.owner;
    expect(w.alarm).toBe(w.t + TURN_MS);
    // The idle person's clock runs out each time it's their step; the other plays on their turns.
    for (let i = 0; i < 400 && room.snapshot.phase === 'playing'; i++) {
      phones.forEach((p) => p.sync());
      const mover = phones.find((p, j) => j !== idle && p.myTurn());
      if (mover) await room.handle(mover.token, mover.action(seeded(i)));
      else {
        w.t = w.alarm!;
        room.alarm();
      }
    }
    expect(room.snapshot.phase).toBe('over');
    expect(room.snapshot.events.at(-1)).toBe(`q${side}`);
    phones.forEach((p) => p.sync());
    // Both phones' games end the same way: the other side won.
    for (const p of phones) expect(ownerRanking(p.state!)).toEqual([1 - side, side]);
    expect(room.members()[idle]!.left).toBe(true);
  });

  it('1v1: Leave game forfeits at once, and the other player wins', async () => {
    const { room, phones } = await started({ ...OPTS, mode: '1v1' }, 2, 13);
    await room.handle(tok(2), { t: 'leave' });
    expect(room.snapshot.phase).toBe('over');
    expect(room.snapshot.events.at(-1)).toBe('q1');
    phones[0]!.sync();
    expect(phones[0]!.over).not.toBeNull();
    expect(ownerRanking(phones[0]!.state!)).toEqual([0, 1]);
  });

  it('a minute offline forfeits; coming back sooner keeps the seat, and a reconnect never resets the clock', async () => {
    const { w, room, phones } = await started({ ...OPTS, mode: '1v1' }, 2, 21);
    const deadline = room.snapshot.deadline!;
    // Person 2 drops and comes back 50 s later: still in, and the current clock wasn't restarted.
    room.disconnected(tok(2));
    expect(room.members()[1]!.online).toBe(false);
    w.t += 20_000;
    room.hello(tok(2), hello(2));
    expect(room.snapshot.deadline).toBe(deadline);
    // Gone for good this time.
    room.disconnected(tok(2));
    for (let i = 0; i < 200 && room.snapshot.phase === 'playing'; i++) {
      phones[0]!.sync();
      if (phones[0]!.myTurn()) await room.handle(tok(1), phones[0]!.action(seeded(i)));
      else {
        w.t = w.alarm!;
        room.alarm();
      }
    }
    expect(room.snapshot.phase).toBe('over');
    expect(room.snapshot.events.at(-1)).toBe('q1');
  });

  it('1v1v1v1: someone who leaves is out, and the rest play on to the end', async () => {
    const { w, room, phones } = await started(OPTS, 4, 5);
    await room.handle(tok(3), { t: 'leave' });
    expect(room.snapshot.phase).toBe('playing');
    expect(room.snapshot.events.at(-1)).toBe('q2');
    await playOut(room, w, phones.filter((_, i) => i !== 2), seeded(6));
    phones.forEach((p) => p.sync());
    expect(ownerRanking(phones[0]!.state!).at(-1)).toBe(2);
  });

  it('2v2: a partner leaving forfeits the team; someone whose colour is already home can go', async () => {
    const { room } = await started({ ...OPTS, mode: '2v2' }, 4, 7);
    // Person 3 (red, team A with person 1) leaves: team A forfeits.
    await room.handle(tok(3), { t: 'leave' });
    expect(room.snapshot.phase).toBe('over');
    expect(room.snapshot.events.at(-1)).toBe('q0');

    // A person whose colour is home leaves: no forfeit (they had nothing left to play).
    const w2 = world(8);
    const r2 = RoomCore.create('FGHJK', { ...OPTS, mode: '2v2' }, w2.io);
    for (let i = 1; i <= 4; i++) r2.hello(tok(i), hello(i));
    await r2.handle(tok(1), { t: 'start' });
    const internal = r2 as unknown as { state: GameState };
    internal.state = { ...internal.state, players: internal.state.players.map((p) => (p.color === 'blue' ? { ...p, tokens: [56, 56, 56, 56] } : p)) };
    await r2.handle(tok(1), { t: 'leave' });
    expect(r2.snapshot.phase).toBe('playing');
    expect(r2.snapshot.events.some((e) => e[0] === 'q')).toBe(false);
  });

  it('ends the game when the last person still playing leaves', async () => {
    const w = world(3);
    const room = RoomCore.create('ABCDE', OPTS, w.io);
    room.hello(tok(1), hello(1));
    room.hello(tok(2), hello(2));
    await room.handle(tok(1), { t: 'start' });
    await room.handle(tok(1), { t: 'leave' });
    expect(room.snapshot.phase).toBe('playing');
    await room.handle(tok(2), { t: 'leave' });
    expect(room.snapshot.phase).toBe('over');
    expect(room.snapshot.events.at(-1)).toBe(STOP_EVENT);
    // The finished room goes away after a while.
    w.t += OVER_MS;
    room.alarm();
    expect(w.destroyed).toBe(true);
  });

  it('picks up after waking from storage, and a reconnecting phone gets the whole game', async () => {
    const w = world(4);
    let room = RoomCore.create('ABCDE', OPTS, w.io);
    room.hello(tok(1), hello(1));
    room.hello(tok(2), hello(2));
    await room.handle(tok(1), { t: 'start' });
    const phones = [new Phone(tok(1), w), new Phone(tok(2), w)];
    const rng = seeded(8);
    for (let i = 0; i < 60; i++) {
      phones.forEach((p) => p.sync());
      const mover = phones.find((p) => p.myTurn());
      if (mover) await room.handle(mover.token, mover.action(rng));
      else {
        w.t = w.alarm!;
        room.alarm();
      }
    }
    // The object is evicted: a new one from the saved data, and phone 2 reconnects with a fresh app.
    room = new RoomCore(structuredClone(w.saved!), w.io);
    room.reattach(tok(1));
    const fresh = new Phone(tok(2), w);
    w.inbox.set(tok(2), []);
    expect(room.hello(tok(2), hello(2))).toBeNull();
    fresh.sync();
    expect(fresh.events).toEqual(room.snapshot.events);
    phones[1] = fresh;
    await playOut(room, w, phones, rng);
    expect(room.snapshot.phase).toBe('over');
  });
});

describe('online room: ranked', () => {
  /** A fake accounts store: every account starts at 1000 and gets +10 for first place, -10 otherwise. */
  const store = (reports: RateReport[]) => async (r: RateReport) => {
    reports.push(r);
    const out: Record<string, { before: number; after: number; games: number }> = {};
    for (const side of r.sides) for (const m of side.members) if ('account' in m) out[m.account] = { before: 1000, after: side.place === 0 ? 1010 : 990, games: 1 };
    return out;
  };

  it('starts at once with the matched people, rates the result, and tells each person', async () => {
    const w = world(11);
    const reports: RateReport[] = [];
    w.io.rate = store(reports);
    const room = RoomCore.ranked('RANK1', { ...OPTS, mode: '2v2' }, [{ token: tok(1), name: 'A', account: 'acc1' }, { token: tok(2), name: 'B', account: 'acc2' }, null, { token: tok(4), name: 'D', account: 'acc4' }], 1150, w.io);
    expect(room.snapshot.phase).toBe('playing');
    expect(room.snapshot.setup!.ranked).toBe(true);
    expect(room.snapshot.setup!.control).toEqual({ blue: 0, green: 1, red: -1, yellow: 2 });
    const phones = [1, 2, 4].map((i) => new Phone(tok(i), w));
    for (const [i, p] of phones.entries()) expect(room.hello(p.token, hello([1, 2, 4][i]!))).toBeNull();
    await playOut(room, w, phones, seeded(3));
    await new Promise((r) => setTimeout(r, 0));
    phones.forEach((p) => p.sync());
    expect(reports).toHaveLength(1);
    // Two sides; the bot on A's side is rated at the room's bot rating.
    expect(reports[0]!.sides.map((x) => x.members)).toContainEqual([{ account: 'acc1' }, { bot: 1150 }]);
    for (const p of phones) expect(p.rated).toMatchObject({ mode: '2v2', before: 1000 });
    // A phone that comes back after the end gets its rating change again.
    w.inbox.set(tok(2), []);
    const back = new Phone(tok(2), w);
    room.hello(tok(2), hello(2));
    back.sync();
    expect(back.rated).not.toBeNull();
  });

  it('a person who leaves ranks last for the rating', async () => {
    const w = world(12);
    const reports: RateReport[] = [];
    w.io.rate = store(reports);
    const room = RoomCore.ranked('RANK2', { ...OPTS, mode: 'ffa' }, [{ token: tok(1), name: 'A', account: 'a' }, { token: tok(2), name: 'B', account: 'b' }, null, null], 1000, w.io);
    room.hello(tok(1), hello(1));
    room.hello(tok(2), hello(2));
    await room.handle(tok(1), { t: 'leave' });
    const phones = [new Phone(tok(2), w)];
    await playOut(room, w, phones, seeded(5));
    await new Promise((r) => setTimeout(r, 0));
    const last = reports[0]!.sides.at(-1)!;
    expect(last.members).toEqual([{ account: 'a' }]);
  });
});

describe('online room: chat (#212)', () => {
  const chats = (w: ReturnType<typeof world>, i: number) => (w.inbox.get(tok(i)) ?? []).filter((m) => m.t === 'chat');
  const twoInRoom = (w: ReturnType<typeof world>) => {
    const room = RoomCore.create('CHATS', { ...OPTS, mode: '1v1' }, w.io);
    expect(room.hello(tok(1), hello(1, 'Asha'))).toBeNull();
    expect(room.hello(tok(2), hello(2, 'Leo'))).toBeNull();
    return room;
  };

  it('announces chat, relays quick phrases, emoji and text to everyone, and keeps none of it', async () => {
    const w = world(21);
    const room = twoInRoom(w);
    const lobby = (w.inbox.get(tok(2)) ?? []).filter((m) => m.t === 'lobby').at(-1)!;
    expect(lobby.t === 'lobby' && lobby.chat).toEqual({ text: true });
    const before = JSON.stringify(room.snapshot);
    expect(await room.handle(tok(1), { t: 'chat', quick: 0 })).toBeNull();
    w.t += 1000;
    expect(await room.handle(tok(2), { t: 'chat', emoji: 2 })).toBeNull();
    w.t += 1000;
    expect(await room.handle(tok(1), { t: 'chat', text: '  hello\u0007   there  ' })).toBeNull();
    for (const i of [1, 2])
      expect(chats(w, i).map((m) => m.t === 'chat' && { from: m.from, quick: m.quick, emoji: m.emoji, text: m.text })).toEqual([
        { from: 0, quick: 0, emoji: undefined, text: undefined },
        { from: 1, quick: undefined, emoji: 2, text: undefined },
        { from: 0, quick: undefined, emoji: undefined, text: 'hello there' },
      ]);
    // Nothing of the chat is in the room's saved data (only the last-activity time moved).
    const strip = (s: string) => s.replace(/"touched":\d+/, '');
    expect(strip(JSON.stringify(room.snapshot))).toBe(strip(before));
    expect(JSON.stringify(room.snapshot)).not.toContain('hello');
  });

  it('allows one line a second each, masks rude words, caps the length, and drops anything unknown', async () => {
    const w = world(22);
    const room = twoInRoom(w);
    await room.handle(tok(1), { t: 'chat', quick: 1 });
    await room.handle(tok(1), { t: 'chat', quick: 2 }); // too soon: dropped
    w.t += 999;
    await room.handle(tok(1), { t: 'chat', quick: 3 }); // still too soon
    w.t += 1;
    await room.handle(tok(1), { t: 'chat', text: `what the shit ${'x'.repeat(200)}` });
    w.t += 1000;
    await room.handle(tok(1), { t: 'chat', quick: 99 });
    await room.handle(tok(1), { t: 'chat', text: '   ' });
    const got = chats(w, 2);
    expect(got).toHaveLength(2);
    const text = got[1]!.t === 'chat' ? got[1]!.text! : '';
    expect(text.startsWith('what the s*** ')).toBe(true);
    expect(text.length).toBe(120);
  });

  it('a Ranked room has quick chat and emoji only: no free text', async () => {
    const w = world(23);
    const room = RoomCore.ranked('RANKC', { ...OPTS, mode: '1v1' }, [{ token: tok(1), name: 'A', account: 'a' }, { token: tok(2), name: 'B', account: 'b' }], 1000, w.io);
    expect(room.hello(tok(1), hello(1))).toBeNull();
    const game = (w.inbox.get(tok(1)) ?? []).find((m) => m.t === 'game')!;
    expect(game.t === 'game' && game.chat).toEqual({ text: false });
    await room.handle(tok(1), { t: 'chat', text: 'hi' });
    w.t += 1000;
    await room.handle(tok(1), { t: 'chat', emoji: 0 });
    expect(chats(w, 1).map((m) => m.t === 'chat' && (m.text ?? m.emoji))).toEqual([0]);
  });

  it('a report goes to the server log with the room and the names, and the reporter hears back', async () => {
    const w = world(24);
    const reports: unknown[] = [];
    w.io.report = (r) => reports.push(r);
    const room = twoInRoom(w);
    expect(await room.handle(tok(2), { t: 'report', from: 0, text: 'something rude' })).toBeNull();
    expect(reports).toEqual([{ room: 'CHATS', reporter: 'Leo', from: 'Asha', text: 'something rude', at: w.t }]);
    expect((w.inbox.get(tok(2)) ?? []).some((m) => m.t === 'reported')).toBe(true);
    expect(await room.handle(tok(2), { t: 'report', from: 7, text: 'x' })).toBe('bad-message');
  });
});

describe('online room: Ranked bots look like players (#216)', () => {
  it('a bot that fills a ranked game is seated, named and timed like a person, and the game counts', async () => {
    const w = world(31);
    const reports: RateReport[] = [];
    w.io.rate = async (r) => {
      reports.push(r);
      return { acc1: { before: 1000, after: 1012, games: 1 } };
    };
    const room = RoomCore.ranked('RANKB', { ...OPTS, mode: '1v1' }, [{ token: tok(1), name: 'Asha', account: 'acc1' }, null], 1100, w.io);
    // The server knows it's a bot.
    expect(room.snapshot.setup!.seats.some((s) => s.bot)).toBe(true);
    expect(room.hello(tok(1), hello(1, 'Asha'))).toBeNull();
    const game = (w.inbox.get(tok(1)) ?? []).find((m) => m.t === 'game')!;
    if (game.t !== 'game') throw new Error('no game');
    // The player doesn't: no bot seat, a person's name, and a clock on its turn.
    expect(game.setup.seats.every((s) => !s.bot && s.level === undefined)).toBe(true);
    expect(BOT_NAMES).toContain(game.setup.names[1]);
    expect(game.setup.names[0]).toBe('Asha');
    const phone = new Phone(tok(1), w);
    await playOut(room, w, [phone], seeded(7));
    // A clock on the bot's turns (the app shows a person's TURN_MS; the server's covers the bots' whole run, #221).
    const turns = (w.inbox.get(tok(1)) ?? []).flatMap((m) => (m.t === 'ev' && m.turn && game.setup.control[m.turn.color] === -1 ? [m.turn.ms] : []));
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.every((ms) => ms !== null && ms >= TURN_MS)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    // It counts: rated with the bot as a side at its rating.
    expect(reports).toHaveLength(1);
    expect(reports[0]!.sides.flatMap((s) => s.members)).toContainEqual({ bot: 1100 });
  });
});

describe('the test hook (#216) can’t exist in production', () => {
  it('answers only with TEST_HOOKS=1 and on localhost', () => {
    const u = 'http://localhost:8787/api/test/rating';
    expect(testHooksAllowed({}, u)).toBe(false);
    expect(testHooksAllowed({ TEST_HOOKS: '0' }, u)).toBe(false);
    expect(testHooksAllowed({ TEST_HOOKS: '1' }, u)).toBe(true);
    expect(testHooksAllowed({ TEST_HOOKS: '1' }, 'http://127.0.0.1:8787/api/test/rating')).toBe(true);
    // A deployed Worker, even if someone set the variable there.
    expect(testHooksAllowed({ TEST_HOOKS: '1' }, 'https://tag-team-ludo-rooms.example.workers.dev/api/test/rating')).toBe(false);
    expect(testHooksAllowed({ TEST_HOOKS: '1' }, 'not a url')).toBe(false);
  });

  it('no environment in wrangler.jsonc sets TEST_HOOKS', async () => {
    // @ts-expect-error: the project has no @types/node; Vitest runs on Node.
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(new URL('../server/wrangler.jsonc', import.meta.url), 'utf8')).not.toContain('TEST_HOOKS');
  });
});

// ---------- #221: ranked bots played in the apps ----------

/** Runs `f` as the server: any rule-bot pick inside counts against the server (it must never pick a bot's move). */
async function asServer<T>(f: () => T | Promise<T>): Promise<T> {
  picks.server = true;
  try {
    return await f();
  } finally {
    picks.server = false;
  }
}

/** A ranked room with `slots` (people's tokens by slot, null = a bot), everyone said hello. */
function rankedRoom(seed: number, mode: RoomOptions['mode'], slots: (number | null)[]) {
  const w = world(seed);
  const logs: Record<string, unknown>[] = [];
  w.io.log = (e) => logs.push(e);
  w.io.rate = async () => ({});
  const room = RoomCore.ranked('RB' + seed, { ...OPTS, mode }, slots.map((i) => (i === null ? null : { token: tok(i), name: `P${i}`, account: `acc${i}` })), 1100, w.io);
  const people = slots.filter((i): i is number => i !== null);
  for (const i of people) expect(room.hello(tok(i), hello(i))).toBeNull();
  const phones = people.map((i) => new Phone(tok(i), w));
  return { w, room, phones, logs };
}

/**
 * Plays a ranked game out as the apps would, with each step checked: on a person's turn the app sends the bots'
 * run it played with its own roll or move; every other app compares the server's run with its own and, when it
 * differs, reports it (`mismatch`) and takes the server's. Counts what the server is woken for.
 */
async function playRanked(room: RoomCore, w: ReturnType<typeof world>, phones: Phone[], rng: () => number) {
  const count = { messages: 0, alarms: 0, botEvents: 0, mismatches: 0 };
  for (let step = 0; step < 20_000; step++) {
    phones.forEach((p) => p.sync());
    if (phones.every((p) => p.over)) return count;
    // What each app played for the bots' run waiting now.
    const runs = phones.map((p) => (p.over ? null : { at: p.events.length, bots: p.local().bots }));
    const act = async (p: Phone, msg: ClientMsg) => {
      count.messages++;
      count.botEvents += 'bots' in msg && msg.bots ? msg.bots.length : 0;
      expect(await asServer(() => room.handle(p.token, msg))).toBeNull();
      // The others compare.
      for (const [i, q] of phones.entries()) {
        const run = runs[i];
        if (q === p || !run || !run.bots.length) continue;
        q.sync();
        const server = q.events.slice(run.at, run.at + run.bots.length);
        const k = run.bots.findIndex((ev, j) => server[j] !== undefined && server[j] !== ev);
        if (k >= 0) {
          count.mismatches++;
          count.messages++;
          await room.handle(q.token, { t: 'mismatch', seq: run.at + k, ev: run.bots[k]! });
        }
      }
    };
    const mover = phones.find((p) => p.myTurn());
    if (mover) {
      await act(mover, mover.action(rng));
      continue;
    }
    const ender = phones.find((p) => p.state && !p.over && p.local().bots.length && p.local().state.phase === 'over');
    if (ender) {
      await act(ender, { t: 'bots', seq: ender.events.length, bots: ender.local().bots });
      continue;
    }
    const short = phones.find((p) => p.state && !p.over && p.local().out && p.draws);
    if (short) {
      count.messages++;
      await asServer(() => room.handle(short.token, { t: 'draws', at: short.draws!.at }));
      continue;
    }
    expect(w.alarm).not.toBeNull();
    w.t = Math.max(w.t, w.alarm!);
    count.alarms++;
    await asServer(() => room.alarm());
  }
  throw new Error('game did not end');
}

describe('online room: ranked bots played in the apps (#221)', () => {
  it('2 people + 2 bots: the apps agree, the bots’ moves ride with the people’s, and the server picks none', async () => {
    const { w, room, phones, logs } = rankedRoom(41, 'ffa', [1, null, 2, null]);
    picks.count = 0;
    const count = await playRanked(room, w, phones, seeded(1));
    expect(picks.count).toBe(0);
    expect(count.mismatches).toBe(0);
    expect(count.alarms).toBe(0); // no step of the bots needed the server's clock
    expect(count.botEvents).toBeGreaterThan(20);
    expect(logs.filter((l) => l.type !== 'bot-mismatch')).toEqual([]);
    // Both apps saw the same game as the server.
    for (const p of phones) expect(p.events).toEqual(room.snapshot.events);
    expect(phones.flatMap((p) => p.errors)).toEqual([]);
  });

  it('one modified app: the server takes its legal run, the other app reports it, takes the server’s, and it’s logged', async () => {
    const { w, room, phones, logs } = rankedRoom(42, 'ffa', [1, null, 2, null]);
    // App 2 plays the bots' last legal move instead of their own (a weak bot for its opponent).
    phones[1]!.cheat = (s) => (s.moves.length > 1 ? moveEvent(s.moves[s.moves.length - 1]!) : null);
    const count = await playRanked(room, w, phones, seeded(2));
    expect(count.mismatches).toBeGreaterThan(0);
    const mism = logs.filter((l) => l.type === 'bot-mismatch');
    expect(mism.length).toBe(count.mismatches);
    // Whichever app's run wasn't the one taken reports it (the honest app, when the modified one moved first).
    expect(mism.every((l) => l.room === 'RB42' && (l.member === 'P1' || l.member === 'P2'))).toBe(true);
    expect(mism.some((l) => l.member === 'P1')).toBe(true);
    // The honest app followed the server's version to the end: the same game everywhere.
    for (const p of phones) expect(p.events).toEqual(room.snapshot.events);
  });

  it('a run that doesn’t check out is turned down and logged, and the app gets the game again', async () => {
    const { w, room, phones, logs } = rankedRoom(43, '1v1', [1, null]);
    const p = phones[0]!;
    // Play until a bots' run is waiting.
    for (let i = 0; i < 200 && !(p.sync(), p.local().bots.length); i++) {
      if (p.myTurn()) await room.handle(p.token, p.action(seeded(i)));
    }
    const { bots, state } = p.local();
    expect(bots.length).toBeGreaterThan(0);
    // A roll the draw doesn't give.
    const wrong = bots.map((ev, i) => (i === 0 ? String((Number(ev) % 6) + 1) : ev));
    const before = (w.inbox.get(p.token) ?? []).filter((m) => m.t === 'game').length;
    const msg: ClientMsg = state.phase === 'roll' ? { t: 'roll', seq: p.events.length, bots: wrong } : { t: 'move', seq: p.events.length, ev: moveEvent(state.moves[0]!), bots: wrong };
    expect(await room.handle(p.token, msg)).toBe('illegal');
    expect(logs.some((l) => l.type === 'bot-run-refused')).toBe(true);
    expect((w.inbox.get(p.token) ?? []).filter((m) => m.t === 'game').length).toBe(before + 1);
    // The honest run still goes.
    p.sync();
    expect(await room.handle(p.token, p.action(seeded(9)))).toBeNull();
  });

  it('1 person + 3 bots: nobody can cross-check; the game plays out on the person’s messages alone', async () => {
    const { w, room, phones, logs } = rankedRoom(44, 'ffa', [1, null, null, null]);
    picks.count = 0;
    const count = await playRanked(room, w, phones, seeded(3));
    expect(picks.count).toBe(0);
    expect(count.alarms).toBe(0);
    expect(logs).toEqual([]);
    expect(phones[0]!.events).toEqual(room.snapshot.events);
  });

  it('a reconnect in the middle of the bots’ run: the app rebuilds from the server’s game, the bot seed and the draws', async () => {
    const { w, room, phones } = rankedRoom(45, 'ffa', [1, null, null, null]);
    let p = phones[0]!;
    for (let i = 0; i < 200 && !(p.sync(), p.local().bots.length > 2); i++) if (p.myTurn()) await room.handle(p.token, p.action(seeded(i)));
    const before = p.local().bots;
    expect(before.length).toBeGreaterThan(2);
    // The app closes mid-run and comes back with nothing but its token.
    room.disconnected(p.token);
    w.inbox.set(p.token, []);
    p = new Phone(p.token, w);
    expect(room.hello(p.token, hello(1))).toBeNull();
    p.sync();
    expect(p.local().bots).toEqual(before);
    expect(await room.handle(p.token, p.action(seeded(1)))).toBeNull();
  });

  it('draws are never used twice: each run gets fresh ones, and a run’s spares are thrown away', async () => {
    const { w, room, phones } = rankedRoom(46, 'ffa', [1, null, 2, null]);
    await playRanked(room, w, phones, seeded(4));
    const runs = new Map<number, number[]>();
    for (const m of w.inbox.get(tok(1)) ?? []) {
      if ((m.t === 'ev' || m.t === 'game') && m.draws) runs.set(m.draws.at, [...(runs.get(m.draws.at) ?? []), ...m.draws.d]);
      if (m.t === 'draws') runs.get(m.at)!.push(...m.d);
    }
    expect(runs.size).toBeGreaterThan(10);
    const seen = new Map<number, number>();
    for (const [at, d] of runs) for (const x of new Set(d)) {
      expect(seen.get(x) ?? at).toBe(at); // a draw value in two runs would mean one was sent again
      seen.set(x, at);
    }
    // Every roll of the bots took the next unused draw of its run (the server rebuilt each face from it).
    expect(room.snapshot.run ?? null).toBeNull();
  });

  it('nobody sends the bots’ run in time: the server plays each bot’s first legal move, logged', async () => {
    const { w, room, phones, logs } = rankedRoom(47, '1v1', [1, null]);
    const p = phones[0]!;
    for (let i = 0; i < 200 && !(p.sync(), p.local().bots.length); i++) if (p.myTurn()) await room.handle(p.token, p.action(seeded(i)));
    const at = p.events.length;
    w.t = w.alarm!;
    picks.count = 0;
    await asServer(() => room.alarm());
    expect(picks.count).toBe(0);
    expect(logs.some((l) => l.type === 'bot-fallback' && l.at === at)).toBe(true);
    // Each bot move was the first legal one.
    let s = rebuild(room.snapshot.setup!, room.snapshot.events.slice(0, at));
    for (const ev of room.snapshot.events.slice(at)) {
      if (s.phase === 'move' && room.snapshot.setup!.control[s.players[s.current]!.color] === -1) expect(ev).toBe(moveEvent(s.moves[0]!));
      if (room.snapshot.setup!.control[s.players[s.current]!.color] !== -1) break;
      s = applyEvent(s, ev);
    }
  });

  it('a person whose clock runs out gets their first legal move (no picker); three in a row still forfeit', async () => {
    const { w, room, phones } = rankedRoom(48, '1v1', [1, 2]);
    picks.count = 0;
    let checked = 0;
    // Person 1 plays. Person 2 rolls but lets the clock run out on every move, until a few were checked; then
    // does nothing at all, and the third timeout in a row forfeits.
    for (let i = 0; i < 2000 && room.snapshot.phase === 'playing'; i++) {
      phones.forEach((p) => p.sync());
      if (phones[0]!.myTurn()) {
        await room.handle(phones[0]!.token, phones[0]!.action(seeded(i)));
        continue;
      }
      const s = rebuild(room.snapshot.setup!, room.snapshot.events);
      if (checked < 3 && phones[1]!.myTurn() && s.phase === 'roll') {
        await room.handle(phones[1]!.token, phones[1]!.action(seeded(i)));
        continue;
      }
      const n = room.snapshot.events.length;
      w.t = w.alarm!;
      await asServer(() => room.alarm());
      if (s.phase === 'move' && room.snapshot.events.length > n && room.snapshot.events[n]![0] !== 'q') {
        expect(room.snapshot.events[n]).toBe(moveEvent(s.moves[0]!));
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
    expect(picks.count).toBe(0);
    expect(room.snapshot.phase).toBe('over');
    expect(room.snapshot.events.at(-1)).toMatch(/^q/);
    expect(room.members()[1]!.left).toBe(true);
  });

  it('an app with other bots (another BOT_VERSION, or none) can’t join a game whose bots the apps play', () => {
    const { room } = rankedRoom(49, '1v1', [1, null]);
    expect(room.hello(tok(1), { ...hello(1), botVersion: BOT_VERSION + 1 })).toBe('protocol');
    expect(room.hello(tok(1), { t: 'hello', protocol: PROTOCOL, token: tok(1), name: 'P1' })).toBe('protocol');
    // Private rooms too (#226): their bots are the apps' as well.
    const w = world(50);
    const priv = RoomCore.create('PRIVA', { ...OPTS, mode: '1v1' }, w.io);
    expect(priv.hello(tok(1), { t: 'hello', protocol: PROTOCOL, token: tok(1), name: 'P1' })).toBe('protocol');
    expect(priv.hello(tok(1), hello(1))).toBeNull();
  });

  it('billed requests per bot game, before (the server played every bot step) and after (the apps do)', async () => {
    const rows: string[] = [];
    for (const [mode, slots, label] of [
      ['1v1', [1, null], '1v1, 1 person + 1 bot'],
      ['ffa', [1, null, null, null], '1v1v1v1, 1 person + 3 bots'],
      ['ffa', [1, null, 2, null], '1v1v1v1, 2 people + 2 bots'],
    ] as const) {
      const { w, room, phones } = rankedRoom(60, mode, [...slots]);
      const c = await playRanked(room, w, phones, seeded(6));
      // Before: one alarm (a billed request) per bot step; the people's messages as now (20 to 1).
      const before = c.botEvents + (c.messages - c.mismatches) / 20;
      const after = c.alarms + c.messages / 20;
      rows.push(`${label}: ${c.botEvents} bot steps; before ${before.toFixed(1)} billed requests, after ${after.toFixed(1)}`);
      expect(after).toBeLessThan(before / 10);
    }
    console.log(['Billed requests per bot game (#221):', ...rows].join('\n  '));
  });
});

// ---------- #226: private rooms' bots played in the apps too ----------

/** A private room of `mode` with `people` people (all said hello), started by the host, its bots at `level`. */
async function privateRoom(seed: number, mode: RoomOptions['mode'], people: number, level: RoomOptions['botLevel'] = 'hard') {
  const w = world(seed);
  const logs: Record<string, unknown>[] = [];
  w.io.log = (e) => logs.push(e);
  const room = RoomCore.create('PB' + seed, { ...OPTS, mode, botLevel: level }, w.io);
  for (let i = 1; i <= people; i++) expect(room.hello(tok(i), hello(i))).toBeNull();
  expect(await room.handle(tok(1), { t: 'start' })).toBeNull();
  const phones = Array.from({ length: people }, (_, i) => new Phone(tok(i + 1), w));
  return { w, room, phones, logs };
}

describe('online room: private rooms\u2019 bots played in the apps (#226)', () => {
  it('the server has no rule bot left: chooseRuleMove appears nowhere in server/', async () => {
    // @ts-expect-error: the project has no @types/node; Vitest runs on Node.
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = new URL('../server/src/', import.meta.url);
    const files = (readdirSync(dir) as string[]).filter((n) => n.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const n of files) expect(readFileSync(new URL(n, dir), 'utf8'), n).not.toMatch(/chooseRuleMove|ai\/choose/);
  });

  it('2 people + 2 bots: the bots are shown as bots at the host\u2019s level; the apps agree and the server picks none', async () => {
    const { w, room, phones, logs } = await privateRoom(51, 'ffa', 2, 'hard');
    const game = (w.inbox.get(tok(1)) ?? []).find((m) => m.t === 'game')!;
    if (game.t !== 'game') throw new Error('no game');
    // Shown as bots, at the level the host picked, and the apps play them.
    expect(game.setup.seats.filter((s) => s.bot).map((s) => s.level)).toEqual(['hard', 'hard']);
    expect(game.bots?.visible).toBe(true);
    expect(Object.values(game.bots!.levels)).toEqual(['hard', 'hard']);
    picks.count = 0;
    const count = await playRanked(room, w, phones, seeded(1));
    expect(picks.count).toBe(0);
    expect(count.mismatches).toBe(0);
    expect(count.alarms).toBe(0);
    expect(count.botEvents).toBeGreaterThan(20);
    expect(logs).toEqual([]);
    for (const p of phones) expect(p.events).toEqual(room.snapshot.events);
  });

  it('one person left with the bots (the other left): that person\u2019s app plays them all', async () => {
    // A private room needs two people to start, so "1 person + bots" is a room whose others have left.
    const { w, room, phones, logs } = await privateRoom(52, 'ffa', 2, 'normal');
    expect(await room.handle(tok(2), { t: 'leave' })).toBeNull();
    picks.count = 0;
    const count = await playRanked(room, w, [phones[0]!], seeded(2));
    expect(picks.count).toBe(0);
    expect(count.alarms).toBe(0);
    expect(count.botEvents).toBeGreaterThan(20);
    expect(logs).toEqual([]);
    expect(phones[0]!.events).toEqual(room.snapshot.events);
  });

  it('a modified app: its legal run is taken, the other app reports it and follows the server, and it\u2019s logged', async () => {
    const { w, room, phones, logs } = await privateRoom(53, '2v2', 2, 'normal');
    phones[1]!.cheat = (s) => (s.moves.length > 1 ? moveEvent(s.moves[s.moves.length - 1]!) : null);
    const count = await playRanked(room, w, phones, seeded(3));
    expect(count.mismatches).toBeGreaterThan(0);
    expect(logs.filter((l) => l.type === 'bot-mismatch').length).toBe(count.mismatches);
    for (const p of phones) expect(p.events).toEqual(room.snapshot.events);
  });

  it('a reconnect in the middle of the bots\u2019 run: the app rebuilds the same run and it\u2019s taken', async () => {
    const { w, room, phones } = await privateRoom(54, 'ffa', 2, 'easy');
    let p = phones[0]!;
    const other = phones[1]!;
    for (let i = 0; i < 400 && !(phones.forEach((q) => q.sync()), p.local().bots.length > 2 && p.myTurn()); i++) {
      const mover = [p, other].find((q) => q.myTurn());
      if (mover) await room.handle(mover.token, mover.action(seeded(i)));
    }
    const before = p.local().bots;
    expect(before.length).toBeGreaterThan(2);
    room.disconnected(p.token);
    w.inbox.set(p.token, []);
    p = new Phone(p.token, w);
    expect(room.hello(p.token, hello(1))).toBeNull();
    p.sync();
    expect(p.local().bots).toEqual(before);
    expect(await room.handle(p.token, p.action(seeded(1)))).toBeNull();
  });

  it('billed requests per private game with bots, before (a server alarm per bot step) and after', async () => {
    const rows: string[] = [];
    for (const [mode, people, label] of [
      ['ffa', 2, '1v1v1v1, 2 people + 2 bots'],
      ['ffa', 3, '1v1v1v1, 3 people + 1 bot'],
      ['2v2', 2, '2v2, 2 people + 2 bots'],
    ] as const) {
      const { w, room, phones } = await privateRoom(70, mode, people, 'normal');
      const c = await playRanked(room, w, phones, seeded(7));
      const before = c.botEvents + (c.messages - c.mismatches) / 20;
      const after = c.alarms + c.messages / 20;
      rows.push(`${label}: ${c.botEvents} bot steps; before ${before.toFixed(1)} billed requests, after ${after.toFixed(1)}`);
      expect(after).toBeLessThan(before / 5);
    }
    console.log(['Billed requests per private game with bots (#226):', ...rows].join('\n  '));
  });
});
