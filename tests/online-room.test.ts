// The online room (server/src/room-core.ts) with a fake clock and fake phones: each phone keeps the game the
// way the app will, by applying the server's events with the engine, and plays a legal move on its turn.
import { describe, expect, it } from 'vitest';
import { STOP_EVENT, applyEvent, createGame, moveEvent, ownerRanking, replay, seeded, type GameState } from '../src/engine';
import { PROTOCOL, type ClientMsg, type GameSetup, type RoomOptions, type ServerMsg } from '../src/net/protocol';
import { LOBBY_MS, OVER_MS, RoomCore, setupFor, type RateReport, TURN_MS, type RoomData, type RoomIO } from '../server/src/room-core';

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
      } else if (m.t === 'ev') {
        expect(m.seq).toBe(this.events.length); // no gaps, no repeats
        this.events.push(m.ev);
        if (m.ev !== STOP_EVENT) this.state = applyEvent(this.state!, m.ev);
      } else if (m.t === 'over') this.over = m;
      else if (m.t === 'rated') this.rated = m;
      else if (m.t === 'error') this.errors.push(m.code);
    }
  }

  myTurn() {
    const s = this.state;
    return !!s && !this.over && s.phase !== 'over' && this.setup!.control[s.players[s.current]!.color] === this.you;
  }

  /** What this phone would send on its turn: a roll, or a random legal move. */
  action(rng: () => number): ClientMsg {
    const s = this.state!;
    if (s.phase === 'roll') return { t: 'roll', seq: this.events.length };
    return { t: 'move', seq: this.events.length, ev: moveEvent(s.moves[Math.floor(rng() * s.moves.length)]!) };
  }
}

const hello = (i: number, name = `P${i}`): Extract<ClientMsg, { t: 'hello' }> => ({ t: 'hello', protocol: PROTOCOL, token: tok(i), name });

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
