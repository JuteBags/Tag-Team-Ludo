// The friends hub (#209, a first version): server/src/friends-core.ts with an in-memory store and fake phones.
import { describe, expect, it } from 'vitest';
import { seeded } from '../src/engine';
import { isFriendCode, type FriendServerMsg } from '../src/net/protocol';
import { FriendsCore, type FriendStore } from '../server/src/friends-core';

function store(): FriendStore & { links: Set<string> } {
  const codes = new Map<string, string>();
  const names = new Map<string, string>();
  const links = new Set<string>();
  const key = (a: string, b: string) => [a, b].sort().join('|');
  return {
    links,
    codeOf: (id) => codes.get(id) ?? null,
    idOfCode: (code) => [...codes].find(([, c]) => c === code)?.[0] ?? null,
    setCode: (id, code) => void codes.set(id, code),
    nameOf: (id) => names.get(id) ?? null,
    setName: (id, name) => void names.set(id, name),
    friendsOf: (id) => [...links].flatMap((k) => { const [a, b] = k.split('|'); return a === id ? [b!] : b === id ? [a!] : []; }),
    link: (a, b) => void links.add(key(a, b)),
    unlink: (a, b) => void links.delete(key(a, b)),
  };
}

function hub() {
  const inbox = new Map<string, FriendServerMsg[]>();
  const s = store();
  const core = new FriendsCore(s, { send: (c, m) => inbox.set(c, [...(inbox.get(c) ?? []), m]), random: seeded(5) });
  const got = (c: string) => inbox.get(c) ?? [];
  const last = (c: string) => got(c).at(-1);
  const me = (c: string) => got(c).find((m) => m.t === 'me') as Extract<FriendServerMsg, { t: 'me' }>;
  return { core, s, got, last, me, inbox };
}

describe('friends (#209)', () => {
  it('gives each account a code, makes friends both ways by code, and says who is online', () => {
    const h = hub();
    h.core.hello('a1', 'A', 'Asha');
    h.core.hello('b1', 'B', 'Leo');
    const codeA = h.me('a1').code;
    expect(isFriendCode(codeA)).toBe(true);
    expect(h.me('b1').code).not.toBe(codeA);
    expect(h.me('a1').friends).toEqual([]);
    expect(h.core.handle('b1', { t: 'add', code: codeA.toLowerCase() })).toBeNull();
    expect(h.last('a1')).toEqual({ t: 'friend', friend: { id: 'B', name: 'Leo', online: true } });
    expect(h.last('b1')).toEqual({ t: 'friend', friend: { id: 'A', name: 'Asha', online: true } });
    // Going offline and back: the friend hears both; hello lists friends with who's online.
    h.core.bye('b1');
    expect(h.last('a1')).toEqual({ t: 'friend', friend: { id: 'B', name: 'Leo', online: false } });
    h.core.hello('b2', 'B', 'Leo');
    expect(h.last('a1')).toEqual({ t: 'friend', friend: { id: 'B', name: 'Leo', online: true } });
    expect(h.me('b2').friends).toEqual([{ id: 'A', name: 'Asha', online: true }]);
    // The same code twice, an unknown code, your own code.
    expect(h.core.handle('b2', { t: 'add', code: codeA })).toBeNull();
    expect(h.s.links.size).toBe(1);
    expect(h.core.handle('b2', { t: 'add', code: 'ZZZZZZ' })).toBe('no-friend');
    expect(h.core.handle('a1', { t: 'add', code: codeA })).toBe('no-friend');
  });

  it('online is any of an account’s connections; the last one closing makes it offline', () => {
    const h = hub();
    h.core.hello('a1', 'A', 'Asha');
    h.core.hello('b1', 'B', 'Leo');
    h.core.handle('a1', { t: 'add', code: h.me('b1').code });
    h.core.hello('b2', 'B', 'Leo'); // a second tab
    const before = h.got('a1').length;
    h.core.bye('b1');
    expect(h.got('a1').length).toBe(before); // still online on b2
    h.core.bye('b2');
    expect(h.last('a1')).toEqual({ t: 'friend', friend: { id: 'B', name: 'Leo', online: false } });
  });

  it('invites only an online friend into a room, and the answer goes back', () => {
    const h = hub();
    h.core.hello('a1', 'A', 'Asha');
    h.core.hello('b1', 'B', 'Leo');
    h.core.hello('c1', 'C', 'Mira');
    expect(h.core.handle('a1', { t: 'invite', to: 'B', room: 'ABCDE' })).toBe('not-friends');
    h.core.handle('a1', { t: 'add', code: h.me('b1').code });
    expect(h.core.handle('a1', { t: 'invite', to: 'B', room: 'not a code' })).toBe('bad-message');
    expect(h.core.handle('a1', { t: 'invite', to: 'B', room: 'ABCDE' })).toBeNull();
    expect(h.last('b1')).toEqual({ t: 'invite', from: { id: 'A', name: 'Asha', online: true }, room: 'ABCDE' });
    expect(h.got('c1').some((m) => m.t === 'invite')).toBe(false);
    expect(h.core.handle('b1', { t: 'reply', to: 'A', room: 'ABCDE', accept: true })).toBeNull();
    expect(h.last('a1')).toEqual({ t: 'reply', from: { id: 'B', name: 'Leo', online: true }, room: 'ABCDE', accept: true });
    h.core.bye('b1');
    expect(h.core.handle('a1', { t: 'invite', to: 'B', room: 'ABCDE' })).toBe('offline');
  });

  it('removing a friend removes them on both sides; a stranger can say nothing before hello', () => {
    const h = hub();
    h.core.hello('a1', 'A', 'Asha');
    h.core.hello('b1', 'B', 'Leo');
    h.core.handle('a1', { t: 'add', code: h.me('b1').code });
    expect(h.core.handle('b1', { t: 'remove', id: 'A' })).toBeNull();
    expect(h.s.friendsOf('A')).toEqual([]);
    expect(h.last('a1')).toEqual({ t: 'friend', friend: { id: 'B', name: 'Leo', online: true }, gone: true });
    expect(h.core.handle('zz', { t: 'ping' })).toBe('bad-message');
  });
});
