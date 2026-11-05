// The online room (server/src/room-core.ts) with a fake clock and fake phones: each phone keeps the game the
// way the app will, by applying the server's events with the engine, and plays a legal move on its turn.
import { describe, expect, it } from 'vitest';
import { STOP_EVENT, applyEvent, createGame, moveEvent, replay, seeded, type GameState } from '../src/engine';
import { PROTOCOL, type ClientMsg, type RoomOptions, type ServerMsg } from '../src/net/protocol';
import { BOT_MOVE_MS, LOBBY_MS, MAX_TIMEOUTS, OVER_MS, RoomCore, TURN_MS, type RoomData, type RoomIO } from '../server/src/room-core';

const OPTS: RoomOptions = { players: 4, singles: false, botLevel: 'normal' };
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
  events: string[] = [];
  you = -1;
  over: Extract<ServerMsg, { t: 'over' }> | null = null;
  lobby: Extract<ServerMsg, { t: 'lobby' }> | null = null;
  errors: string[] = [];
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
        this.events = [...m.events];
        this.state = createGame(m.setup.seats, m.setup.first, m.setup.singles);
        for (const ev of m.events) if (ev !== STOP_EVENT) this.state = applyEvent(this.state, ev);
      } else if (m.t === 'ev') {
        expect(m.seq).toBe(this.events.length); // no gaps, no repeats
        this.events.push(m.ev);
        if (m.ev !== STOP_EVENT) this.state = applyEvent(this.state!, m.ev);
      } else if (m.t === 'over') this.over = m;
      else if (m.t === 'error') this.errors.push(m.code);
    }
  }

  myTurn() {
    const s = this.state;
    return !!s && !this.over && s.phase !== 'over' && s.players[s.current]!.owner === this.you && !s.players[s.current]!.bot;
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
    const room = RoomCore.create('ABCDE', { ...OPTS, players: 2 }, w.io);
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
    ['2 houses, 2 people, no doubles', { ...OPTS, players: 2, singles: true }, 2],
    ['3 houses, 3 people, hard bots', { ...OPTS, players: 3, botLevel: 'hard' }, 3],
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

  it('turns down stale, out-of-turn and illegal actions', async () => {
    const w = world(5);
    const room = RoomCore.create('ABCDE', { ...OPTS, players: 2 }, w.io);
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

  it('plays for someone whose time runs out, and a bot takes over after repeated timeouts', async () => {
    const w = world(9);
    const room = RoomCore.create('ABCDE', { ...OPTS, players: 2 }, w.io);
    room.hello(tok(1), hello(1));
    room.hello(tok(2), hello(2));
    await room.handle(tok(1), { t: 'start' });
    const phones = [new Phone(tok(1), w), new Phone(tok(2), w)];
    phones.forEach((p) => p.sync());
    // Whoever plays first never acts: their clock runs out on each action.
    const idle = phones.findIndex((p) => p.myTurn());
    expect(w.alarm).toBe(w.t + TURN_MS);
    const before = room.snapshot.events.length;
    w.t += TURN_MS;
    room.alarm();
    expect(room.snapshot.events.length).toBe(before + 1);
    // Keep going until the bot stands in for them, then the game still finishes.
    for (let i = 0; i < 50 && !room.members()[idle]!.auto; i++) {
      phones.forEach((p) => p.sync());
      const mover = phones.find((p, j) => j !== idle && p.myTurn());
      if (mover) await room.handle(mover.token, mover.action(seeded(i)));
      else {
        w.t = w.alarm!;
        room.alarm();
      }
    }
    expect(room.members()[idle]!.auto).toBe(true);
    expect(room.snapshot.members[idle]!.timeouts).toBeGreaterThanOrEqual(MAX_TIMEOUTS);
    await playOut(room, w, phones, seeded(4), new Set([idle]));
    // Bot steps are paced, not instant.
    expect(BOT_MOVE_MS).toBeGreaterThan(0);
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
