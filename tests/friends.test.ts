// The friends hub (#209; requests #237): server/src/friends-core.ts with an in-memory store, fake phones and fake rooms.
import { describe, expect, it } from 'vitest';
import { seeded, type Color } from '../src/engine';
import { isFriendCode, type FriendServerMsg } from '../src/net/protocol';
import { FriendsCore, MAX_WAITING_OUT, REPEAT_MS, REQUESTS_PER_HOUR, type FriendStore, type StoredRequest } from '../server/src/friends-core';

function store(): FriendStore & { links: Set<string>; reqs: StoredRequest[] } {
  const codes = new Map<string, string>();
  const names = new Map<string, string>();
  const links = new Set<string>();
  const asked = new Map<string, number>();
  const reqs: StoredRequest[] = [];
  const key = (a: string, b: string) => [a, b].sort().join('|');
  return {
    links,
    reqs,
    codeOf: (id) => codes.get(id) ?? null,
    idOfCode: (code) => [...codes].find(([, c]) => c === code)?.[0] ?? null,
    setCode: (id, code) => void codes.set(id, code),
    nameOf: (id) => names.get(id) ?? null,
    setName: (id, name) => void names.set(id, name),
    friendsOf: (id) => [...links].flatMap((k) => { const [a, b] = k.split('|'); return a === id ? [b!] : b === id ? [a!] : []; }),
    link: (a, b) => void links.add(key(a, b)),
    unlink: (a, b) => void links.delete(key(a, b)),
    addRequest: (r) => void reqs.push(r),
    removeRequest: (id) => void reqs.splice(reqs.findIndex((r) => r.id === id), 1),
    requestsTo: (id) => reqs.filter((r) => r.to === id),
    requestsFrom: (id) => reqs.filter((r) => r.from === id),
    lastAsked: (a, b) => asked.get(`${a}>${b}`) ?? null,
    setAsked: (a, b, at) => void asked.set(`${a}>${b}`, at),
  };
}

/** A hub with a clock and rooms: `rooms[code]` is each colour's account (null for a bot or no account). */
function hub(rooms: Record<string, Partial<Record<Color, string | null>>> = {}) {
  const inbox = new Map<string, FriendServerMsg[]>();
  const s = store();
  const clock = { t: 1_000_000 };
  const core = new FriendsCore(s, {
    send: (c, m) => inbox.set(c, [...(inbox.get(c) ?? []), m]),
    random: seeded(5),
    now: () => clock.t,
    // A room answers only someone who played in it.
    seatAccounts: async (room, me) => (rooms[room] && Object.values(rooms[room]!).includes(me) ? rooms[room]! : null),
  });
  const got = (c: string) => inbox.get(c) ?? [];
  const last = (c: string) => got(c).at(-1);
  const lastOf = <T extends FriendServerMsg['t']>(c: string, t: T) => got(c).filter((m) => m.t === t).at(-1) as Extract<FriendServerMsg, { t: T }> | undefined;
  const me = (c: string) => got(c).find((m) => m.t === 'me') as Extract<FriendServerMsg, { t: 'me' }>;
  /** A hello from an app that knows requests (4.0.1); `old`: a 4.0.0 app. */
  const hello = (conn: string, id: string, name: string, old = false) => core.hello(conn, id, name, false, !old);
  return { core, hello, s, got, last, lastOf, me, inbox, clock };
}

/** A and B online, A has asked B by code; B's request id. */
async function asked() {
  const h = hub();
  h.hello('a1', 'A', 'Asha');
  h.hello('b1', 'B', 'Leo');
  expect(await h.core.handle('a1', { t: 'add', code: h.me('b1').code })).toBeNull();
  return { h, id: h.lastOf('b1', 'request')!.from.id };
}

describe('friends (#209)', () => {
  it('gives each account a code, and says who is online', async () => {
    const h = hub();
    h.hello('a1', 'A', 'Asha');
    h.hello('b1', 'B', 'Leo');
    const codeA = h.me('a1').code;
    expect(isFriendCode(codeA)).toBe(true);
    expect(h.me('b1').code).not.toBe(codeA);
    expect(h.me('a1').friends).toEqual([]);
    expect(h.me('a1').requests).toEqual([]);
    // Friends (by request, accepted): online and offline are heard.
    await h.core.handle('b1', { t: 'add', code: codeA.toLowerCase() });
    await h.core.handle('a1', { t: 'answer', id: h.lastOf('a1', 'request')!.from.id, accept: true });
    h.core.bye('b1');
    expect(h.last('a1')).toEqual({ t: 'friend', friend: { id: 'B', name: 'Leo', online: false } });
    h.hello('b2', 'B', 'Leo');
    expect(h.last('a1')).toEqual({ t: 'friend', friend: { id: 'B', name: 'Leo', online: true } });
    expect(h.me('b2').friends).toEqual([{ id: 'A', name: 'Asha', online: true }]);
    // An unknown code, your own code.
    expect(await h.core.handle('b2', { t: 'add', code: 'ZZZZZZ' })).toBe('no-friend');
    expect(await h.core.handle('a1', { t: 'add', code: codeA })).toBe('no-friend');
  });

  it('online is any of an account’s connections; the last one closing makes it offline', async () => {
    const { h, id } = await asked();
    await h.core.handle('b1', { t: 'answer', id, accept: true });
    h.hello('b2', 'B', 'Leo'); // a second tab
    const before = h.got('a1').length;
    h.core.bye('b1');
    expect(h.got('a1').length).toBe(before); // still online on b2
    h.core.bye('b2');
    expect(h.last('a1')).toEqual({ t: 'friend', friend: { id: 'B', name: 'Leo', online: false } });
  });

  it('invites only an online friend into a room, and the answer goes back', async () => {
    const { h, id } = await asked();
    h.hello('c1', 'C', 'Mira');
    expect(await h.core.handle('a1', { t: 'invite', to: 'B', room: 'ABCDE' })).toBe('not-friends'); // only asked
    await h.core.handle('b1', { t: 'answer', id, accept: true });
    expect(await h.core.handle('a1', { t: 'invite', to: 'B', room: 'not a code' })).toBe('bad-message');
    expect(await h.core.handle('a1', { t: 'invite', to: 'B', room: 'ABCDE' })).toBeNull();
    expect(h.last('b1')).toEqual({ t: 'invite', from: { id: 'A', name: 'Asha', online: true }, room: 'ABCDE' });
    expect(h.got('c1').some((m) => m.t === 'invite')).toBe(false);
    expect(await h.core.handle('b1', { t: 'reply', to: 'A', room: 'ABCDE', accept: true })).toBeNull();
    expect(h.last('a1')).toEqual({ t: 'reply', from: { id: 'B', name: 'Leo', online: true }, room: 'ABCDE', accept: true });
    h.core.bye('b1');
    expect(await h.core.handle('a1', { t: 'invite', to: 'B', room: 'ABCDE' })).toBe('offline');
  });

  it('removing a friend removes them on both sides; a stranger can say nothing before hello', async () => {
    const { h, id } = await asked();
    await h.core.handle('b1', { t: 'answer', id, accept: true });
    expect(await h.core.handle('b1', { t: 'remove', id: 'A' })).toBeNull();
    expect(h.s.friendsOf('A')).toEqual([]);
    expect(h.last('a1')).toEqual({ t: 'friend', friend: { id: 'B', name: 'Leo', online: true }, gone: true });
    expect(await h.core.handle('zz', { t: 'ping' })).toBe('bad-message');
  });
});

describe('friend requests (#237)', () => {
  it('a request waits for an answer: the other person hears it at once, and accepting makes friends both ways', async () => {
    const { h, id } = await asked();
    // No instant friends.
    expect(h.s.friendsOf('A')).toEqual([]);
    expect(h.lastOf('b1', 'request')).toEqual({ t: 'request', from: { id, name: 'Asha', at: h.clock.t } });
    expect(h.lastOf('b1', 'requests')).toEqual({ t: 'requests', requests: [{ id, name: 'Asha', at: h.clock.t }], out: 0 });
    expect(h.lastOf('a1', 'requests')).toEqual({ t: 'requests', requests: [], out: 1 });
    // The id is the request's own, never an account id.
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    // Someone coming online later finds it in hello.
    h.hello('b2', 'B', 'Leo');
    expect(h.me('b2').requests).toEqual([{ id, name: 'Asha', at: h.clock.t }]);
    expect(await h.core.handle('b1', { t: 'answer', id, accept: true })).toBeNull();
    expect(h.s.friendsOf('A')).toEqual(['B']);
    expect(h.lastOf('a1', 'friend')).toEqual({ t: 'friend', friend: { id: 'B', name: 'Leo', online: true } });
    expect(h.lastOf('b1', 'friend')).toEqual({ t: 'friend', friend: { id: 'A', name: 'Asha', online: true } });
    expect(h.lastOf('a1', 'requests')!.out).toBe(0);
    expect(h.lastOf('b1', 'requests')!.requests).toEqual([]);
    // Answering again (another tab) does nothing.
    expect(await h.core.handle('b2', { t: 'answer', id, accept: true })).toBeNull();
  });

  it('declining leaves no friendship, and the same person can’t ask again within a day', async () => {
    const { h, id } = await asked();
    expect(await h.core.handle('b1', { t: 'answer', id, accept: false })).toBeNull();
    expect(h.s.friendsOf('A')).toEqual([]);
    expect(h.s.reqs).toEqual([]);
    const code = h.me('b1').code;
    expect(await h.core.handle('a1', { t: 'add', code })).toBe('limit');
    h.clock.t += REPEAT_MS;
    expect(await h.core.handle('a1', { t: 'add', code })).toBeNull();
    expect(h.s.reqs).toHaveLength(1);
  });

  it('a duplicate is nothing; asking someone who already asked you makes you friends', async () => {
    const { h } = await asked();
    expect(await h.core.handle('a1', { t: 'add', code: h.me('b1').code })).toBeNull();
    expect(h.s.reqs).toHaveLength(1);
    // B asks A back: that's a yes on both sides.
    expect(await h.core.handle('b1', { t: 'add', code: h.me('a1').code })).toBeNull();
    expect(h.s.friendsOf('B')).toEqual(['A']);
    expect(h.s.reqs).toEqual([]);
    // Friends already: asking is nothing.
    expect(await h.core.handle('a1', { t: 'add', code: h.me('b1').code })).toBeNull();
    expect(h.s.reqs).toEqual([]);
  });

  it('limits: so many requests an hour, and so many waiting', async () => {
    const h = hub();
    h.hello('a1', 'A', 'Asha');
    const codes: string[] = [];
    for (let i = 0; i < MAX_WAITING_OUT + 5; i++) {
      h.hello(`p${i}`, `P${i}`, `P${i}`);
      codes.push(h.me(`p${i}`).code);
    }
    let ok = 0;
    for (const code of codes.slice(0, REQUESTS_PER_HOUR + 3)) if ((await h.core.handle('a1', { t: 'add', code })) === null) ok++;
    expect(ok).toBe(REQUESTS_PER_HOUR); // the hour's cap
    h.clock.t += 3_600_000;
    for (const code of codes.slice(REQUESTS_PER_HOUR)) await h.core.handle('a1', { t: 'add', code });
    expect(h.s.requestsFrom('A')).toHaveLength(MAX_WAITING_OUT); // the waiting cap
    expect(await h.core.handle('a1', { t: 'add', code: codes.at(-1)! })).toBe('limit');
  });

  it('by seat after a game: only someone who was in the room, only a person with an account; partners too', async () => {
    const h = hub({ RMABC: { blue: 'A', green: 'B', red: 'C', yellow: null }, RMDEF: { blue: 'X', green: 'Y' } });
    h.hello('a1', 'A', 'Asha');
    h.hello('b1', 'B', 'Leo');
    // A asks whoever played green (B) and red (C, a teammate in 2v2: anyone in the room counts).
    expect(await h.core.handle('a1', { t: 'request', room: 'RMABC', color: 'green' })).toBeNull();
    expect(h.lastOf('b1', 'request')!.from.name).toBe('Asha');
    expect(await h.core.handle('a1', { t: 'request', room: 'RMABC', color: 'red' })).toBeNull();
    // A bot, or a person without an account: no request.
    expect(await h.core.handle('a1', { t: 'request', room: 'RMABC', color: 'yellow' })).toBe('no-account');
    // Yourself; a room you weren't in (it can't be used to look accounts up); not a room code.
    expect(await h.core.handle('a1', { t: 'request', room: 'RMABC', color: 'blue' })).toBe('no-friend');
    expect(await h.core.handle('a1', { t: 'request', room: 'RMDEF', color: 'blue' })).toBe('bad-message');
    expect(await h.core.handle('a1', { t: 'request', room: 'nope', color: 'blue' })).toBe('bad-message');
  });

  it('the room’s standing for the result screen: friend, requested, incoming, none, unavailable (no account ids)', async () => {
    const h = hub({ RMABC: { blue: 'A', green: 'B', red: 'C', yellow: null }, RMGHJ: { blue: 'D', green: 'A' } });
    h.hello('a1', 'A', 'Asha');
    h.hello('b1', 'B', 'Leo');
    h.hello('c1', 'C', 'Mira');
    h.hello('d1', 'D', 'Omar');
    await h.core.handle('a1', { t: 'request', room: 'RMABC', color: 'green' }); // A → B
    await h.core.handle('c1', { t: 'request', room: 'RMABC', color: 'blue' }); // C → A
    expect(await h.core.handle('a1', { t: 'room', code: 'RMABC' })).toBeNull();
    const room = h.lastOf('a1', 'room')!;
    expect(room).toEqual({ t: 'room', code: 'RMABC', states: { green: 'requested', red: 'incoming', yellow: 'unavailable' } });
    expect(JSON.stringify(room)).not.toMatch(/"[ABCD]"/);
    await h.core.handle('b1', { t: 'answer', id: h.lastOf('b1', 'request')!.from.id, accept: true });
    await h.core.handle('a1', { t: 'room', code: 'RMABC' });
    expect(h.lastOf('a1', 'room')!.states.green).toBe('friend');
    // Someone who wasn't in the room learns nothing.
    expect(await h.core.handle('d1', { t: 'room', code: 'RMABC' })).toBe('bad-message');
  });
});

describe('friend links (#238)', () => {
  it('who: the name behind a friend code for the prompt; no one for an unknown code; your own is marked', async () => {
    const h = hub();
    h.hello('a1', 'A', 'Asha');
    h.hello('b1', 'B', 'Leo');
    const codeA = h.me('a1').code;
    expect(await h.core.handle('b1', { t: 'who', code: codeA.toLowerCase() })).toBeNull();
    expect(h.last('b1')).toEqual({ t: 'who', code: codeA, name: 'Asha' });
    await h.core.handle('b1', { t: 'who', code: 'ZZZZZZ' });
    expect(h.last('b1')).toEqual({ t: 'who', code: 'ZZZZZZ', name: null });
    await h.core.handle('a1', { t: 'who', code: codeA });
    expect(h.last('a1')).toEqual({ t: 'who', code: codeA, name: null, self: true });

describe('friends with 4.0.0 apps (#237: no requests there)', () => {
  it('4.0.0 adds by code instantly, as before, and never gets request messages it can’t show', async () => {
    const h = hub();
    h.hello('old', 'O', 'Omar', true);
    h.hello('b1', 'B', 'Leo');
    expect(h.me('old')).not.toHaveProperty('requests');
    expect(await h.core.handle('old', { t: 'add', code: h.me('b1').code })).toBeNull();
    expect(h.s.friendsOf('O')).toEqual(['B']);
    expect(h.lastOf('old', 'friend')).toEqual({ t: 'friend', friend: { id: 'B', name: 'Leo', online: true } });
    expect(h.lastOf('b1', 'friend')).toEqual({ t: 'friend', friend: { id: 'O', name: 'Omar', online: true } });
  });

  it('a 4.0.1 request to someone on 4.0.0 waits quietly, and shows once they update', async () => {
    const h = hub();
    h.hello('old', 'O', 'Omar', true);
    h.hello('b1', 'B', 'Leo');
    expect(await h.core.handle('b1', { t: 'add', code: h.me('old').code })).toBeNull();
    expect(h.got('old').some((m) => m.t === 'request' || m.t === 'requests')).toBe(false);
    expect(h.s.reqs).toHaveLength(1);
    h.core.bye('old');
    h.hello('new', 'O', 'Omar'); // updated
    expect(h.me('new').requests).toEqual([{ id: h.s.reqs[0]!.id, name: 'Leo', at: h.clock.t }]);
  });

  it('an old app adding someone who had asked them clears that request', async () => {
    const h = hub();
    h.hello('old', 'O', 'Omar', true);
    h.hello('b1', 'B', 'Leo');
    await h.core.handle('b1', { t: 'add', code: h.me('old').code });
    await h.core.handle('old', { t: 'add', code: h.me('b1').code });
    expect(h.s.friendsOf('B')).toEqual(['O']);
    expect(h.s.reqs).toEqual([]);
    expect(h.lastOf('b1', 'requests')!.out).toBe(0);
  });
});
