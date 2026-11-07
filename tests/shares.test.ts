// Shared games as short links (#229): the server's share API (server/src/shares-core.ts) with an in-memory store.
import { describe, expect, it } from 'vitest';
import { encodeRecord, seeded, type GameRecord } from '../src/engine';
import { KEEP_SHARE_MS, MAX_SHARE_REC, MAX_SHARE_SUM, MemoryShares, SHARES_PER_IP_HOUR, SHARE_CODE_LEN, isShareCode, shardOf, shareApi, type ShareDeps } from '../server/src/shares-core';
import { Windows } from '../server/src/limits';

const rec: GameRecord = {
  v: 1,
  seats: [
    { color: 'blue', owner: 0, bot: false },
    { color: 'green', owner: 1, bot: true, level: 'normal' },
  ],
  first: 'blue',
  meta: { mode: 'pvc', names: ['Blue', 'Bot'] },
  events: '',
};

/** The API over a Map, with the hour's per-IP count as the server keeps it, and a clock. */
function api() {
  const store = new MemoryShares();
  const perIp = new Windows(SHARES_PER_IP_HOUR);
  const clock = { now: 1_000_000 };
  const deps: ShareDeps = {
    put: async (code, s) => store.put(code, s, clock.now),
    get: async (code) => store.get(code, clock.now),
    allow: async (ip) => perIp.hit(ip, clock.now),
    random: seeded(7),
  };
  const post = (body: unknown, ip = '1.2.3.4') =>
    shareApi(new Request('https://s/api/share', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), ip, deps);
  const get = (code: string) => shareApi(new Request(`https://s/api/share/${code}`), '9.9.9.9', deps);
  return { store, clock, post, get };
}

describe('shared games as short links (#229)', () => {
  it('upload, get a random code, and anyone fetches the same record and summary', async () => {
    const { post, get } = api();
    const r = await encodeRecord(rec);
    const res = await post({ rec: r, sum: 'abc_DEF-123' });
    expect(res.status).toBe(200);
    const { code } = (await res.json()) as { code: string };
    expect(code).toHaveLength(SHARE_CODE_LEN);
    expect(isShareCode(code)).toBe(true);
    expect(shardOf(code)).toBe(`shares:${code[0]}`);
    const back = await get(code);
    expect(back.status).toBe(200);
    expect(await back.json()).toEqual({ rec: r, sum: 'abc_DEF-123' });
    // Any case works (codes are read out or typed).
    expect((await get(code.toLowerCase())).status).toBe(200);
    // Without a summary too; and a second upload gets another code.
    const two = (await (await post({ rec: r })).json()) as { code: string };
    expect(two.code).not.toBe(code);
    expect(await (await get(two.code)).json()).toEqual({ rec: r, sum: null });
  });

  it('an unknown or malformed code is a 404', async () => {
    const { get } = api();
    expect((await get('ABCDEFGHJKLM')).status).toBe(404);
    expect((await get('short')).status).toBe(404);
    expect((await get('../../etc')).status).toBe(404);
  });

  it('size caps: a record or a summary over the cap is turned away, and so is anything that isn’t a game', async () => {
    const { post } = api();
    const r = await encodeRecord(rec);
    expect((await post({ rec: 'A'.repeat(MAX_SHARE_REC + 1) })).status).toBe(413);
    expect((await post({ rec: r, sum: 'a'.repeat(MAX_SHARE_SUM + 1) })).status).toBe(413);
    expect((await post('{"rec": "' + 'x'.repeat(80_000) + '"}')).status).toBe(413);
    expect((await post({ rec: 'notagame' })).status).toBe(400);
    expect((await post({ rec: r, sum: 'has spaces <script>' })).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it('rate cap: so many shares per IP an hour, then 429; other IPs and the next hour are fine', async () => {
    const { post, clock } = api();
    const r = await encodeRecord(rec);
    for (let i = 0; i < SHARES_PER_IP_HOUR; i++) expect((await post({ rec: r })).status).toBe(200);
    expect((await post({ rec: r })).status).toBe(429);
    expect((await post({ rec: r }, '5.6.7.8')).status).toBe(200);
    clock.now += 3_600_000;
    expect((await post({ rec: r })).status).toBe(200);
  });

  it('a share is kept a year after it was last opened; opening it keeps it', async () => {
    const { post, get, clock, store } = api();
    const { code } = (await (await post({ rec: await encodeRecord(rec) })).json()) as { code: string };
    clock.now += KEEP_SHARE_MS - 1000;
    expect((await get(code)).status).toBe(200); // opened: another year
    clock.now += KEEP_SHARE_MS - 1000;
    expect((await get(code)).status).toBe(200);
    clock.now += KEEP_SHARE_MS;
    expect((await get(code)).status).toBe(404);
    expect(store.sweep(clock.now - KEEP_SHARE_MS + 1)).toBe(1);
  });

  it('codes are random, not sequential: many in a row share no prefix pattern', async () => {
    const { post } = api();
    const r = await encodeRecord(rec);
    const codes: string[] = [];
    for (let i = 0; i < SHARES_PER_IP_HOUR; i++) codes.push(((await (await post({ rec: r }, `10.0.0.${i}`)).json()) as { code: string }).code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(codes.map((c) => c.slice(0, 3))).size).toBeGreaterThan(codes.length - 2);
  });
});

describe('the app side of short links (#229)', () => {
  it('a short link carries only the code; old #game= links still read as before', async () => {
    const { shortLink, linkCode, linkPayload } = await import('../src/ui/replay');
    const url = shortLink('ABCDEFGHJKLM', 'https://site/');
    expect(url).toBe('https://site/play/#g=ABCDEFGHJKLM');
    expect(linkCode('#g=ABCDEFGHJKLM')).toBe('ABCDEFGHJKLM');
    expect(linkCode('#g=abcdefghjklm')).toBe('ABCDEFGHJKLM');
    expect(linkCode('#g=short')).toBeNull();
    expect(linkCode('#game=xyz')).toBeNull();
    expect(linkPayload('#game=xyz')).toBe('xyz');
    expect(linkPayload('#g=ABCDEFGHJKLM')).toBeNull();
  });

  it('a shared review is used only when it fits its game (it’s untrusted); the older version isn’t shared', async () => {
    const { sharedReview, sharedSummary } = await import('../src/ui/replay');
    const move = { at: 3, owner: 0, played: 0, best: 1, playedChance: 0.4, bestChance: 0.5, gap: 10, se: 1, label: 'mistake', gaps: [10, 0] };
    const luck = { at: 2, owner: 1, face: 6, luck: 4.5, sd: 2 };
    const good = { v: 7, moves: [move], luck: [luck], chances: [[50, 50]], who: [0], done: true };
    expect(sharedReview(good, 10)).toEqual(good);
    expect(sharedSummary({ ...good, old: { v: 6, moves: [], luck: null } } as never)).toEqual(good);
    // Anything off: undefined (the viewer's app works the review out itself).
    expect(sharedReview(null, 10)).toBeUndefined();
    expect(sharedReview({ ...good, moves: [{ ...move, at: 99 }] }, 10)).toBeUndefined();
    expect(sharedReview({ ...good, moves: [{ ...move, label: 'genius' }] }, 10)).toBeUndefined();
    expect(sharedReview({ ...good, moves: [{ ...move, playedChance: 7 }] }, 10)).toBeUndefined();
    expect(sharedReview({ ...good, luck: [{ ...luck, face: 9 }] }, 10)).toBeUndefined();
    expect(sharedReview({ ...good, chances: 'x' }, 10)).toBeUndefined();
    expect(sharedReview({ ...good, moves: 'x' }, 10)).toBeUndefined();
    // Unknown fields don't come through.
    expect(sharedReview({ ...good, script: '<b>' }, 10)).not.toHaveProperty('script');
  });
});
