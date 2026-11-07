// Shared games as short links (#229): a game uploaded once (the shared record, forSharing in src/ui/replay.ts, and
// the sharer's own review summary), fetched by anyone with its code. Pure (no Cloudflare APIs), so
// tests/shares.test.ts drives it with an in-memory store; shares.ts keeps the rows in SQLite and index.ts routes
//   POST /api/share        {rec, sum?}  ->  {code}
//   GET  /api/share/<code>              ->  {rec, sum}  (404 for an unknown code)
// The server never reads the review: `sum` is stored and handed back as it came (the viewer's app can always
// recompute it from the record). The record is checked to be a game before it's kept.
import { decodeRecord } from '../../src/engine/record';
import { CODE_ALPHABET } from '../../src/net/protocol';

/** A share's code: random, unguessable (12 of 32 characters: 60 bits), never sequential. */
export const SHARE_CODE_LEN = 12;
/** The most a shared record (encoded, as in a #game= link) and the review summary (compressed, base64url) may be. */
export const MAX_SHARE_REC = 16_000;
export const MAX_SHARE_SUM = 48_000;
/** New shares per IP per hour (#220: generous, many phones share one IP on mobile networks). */
export const SHARES_PER_IP_HOUR = 30;
/** A share is kept this long after it was last opened (or made). */
export const KEEP_SHARE_MS = 365 * 24 * 3_600_000;
/** How many objects the shares are spread over (by the code's first character). */
export const SHARE_SHARDS = CODE_ALPHABET.length;

export const isShareCode = (s: string) => s.length === SHARE_CODE_LEN && [...s].every((c) => CODE_ALPHABET.includes(c));
export const newShareCode = (random: () => number) => Array.from({ length: SHARE_CODE_LEN }, () => CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)]).join('');
/** The object (shard) that keeps a code's share. */
export const shardOf = (code: string) => `shares:${code[0]}`;

export interface Share {
  rec: string;
  sum: string | null;
}

/** Where shares are kept (SQLite in the Shares object; a Map in tests). */
export interface ShareStore {
  /** Keeps a new share; false when the code is taken. */
  put(code: string, share: Share, now: number): boolean;
  /** A share, and marks it opened now (it's kept a year from its last opening); null when unknown or expired. */
  get(code: string, now: number): Share | null;
  /** Forgets shares last opened before `before`; how many. */
  sweep(before: number): number;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

/** An upload's body checked: the record must be a game, the summary a compressed blob of the allowed size. */
export async function checkUpload(body: unknown): Promise<Share | { error: string }> {
  const b = body as { rec?: unknown; sum?: unknown } | null;
  if (!b || typeof b.rec !== 'string') return { error: 'no record' };
  if (b.rec.length > MAX_SHARE_REC) return { error: 'the record is too large' };
  if (b.sum !== undefined && b.sum !== null && (typeof b.sum !== 'string' || !B64URL.test(b.sum))) return { error: 'a bad summary' };
  if (typeof b.sum === 'string' && b.sum.length > MAX_SHARE_SUM) return { error: 'the summary is too large' };
  if (!(await decodeRecord(b.rec))) return { error: 'not a game record' };
  return { rec: b.rec, sum: typeof b.sum === 'string' ? b.sum : null };
}

/** A Map-backed store, for tests (and as the reference for shares.ts). */
export class MemoryShares implements ShareStore {
  rows = new Map<string, Share & { opened: number }>();
  put(code: string, share: Share, now: number) {
    if (this.rows.has(code)) return false;
    this.rows.set(code, { ...share, opened: now });
    return true;
  }
  get(code: string, now: number) {
    const r = this.rows.get(code);
    if (!r || now - r.opened >= KEEP_SHARE_MS) return null;
    r.opened = now;
    return { rec: r.rec, sum: r.sum };
  }
  sweep(before: number) {
    let n = 0;
    for (const [k, r] of this.rows) if (r.opened < before && this.rows.delete(k)) n++;
    return n;
  }
}

/** What the share API needs from the outside: the store (by code), the per-IP limit, and randomness. */
export interface ShareDeps {
  put(code: string, share: Share): Promise<boolean>;
  get(code: string): Promise<Share | null>;
  /** Whether this IP may share again now (the binding and SHARES_PER_IP_HOUR, #220). */
  allow(ip: string): Promise<boolean>;
  random: () => number;
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });
/** The largest upload body read (the record, the summary and a little JSON). */
const MAX_BODY = MAX_SHARE_REC + MAX_SHARE_SUM + 1_000;

/** /api/share and /api/share/<code>: a new share, or one by its code. */
export async function shareApi(req: Request, ip: string, deps: ShareDeps): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method === 'GET') {
    const code = path.slice('/api/share/'.length).toUpperCase();
    if (!isShareCode(code)) return reply({ error: 'not found' }, 404);
    const share = await deps.get(code);
    return share ? reply(share) : reply({ error: 'not found' }, 404);
  }
  if (req.method !== 'POST' || path !== '/api/share') return reply({ error: 'not found' }, 404);
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return reply({ error: 'too large' }, 413);
  const text = await req.text();
  if (text.length > MAX_BODY) return reply({ error: 'too large' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return reply({ error: 'bad body' }, 400);
  }
  const share = await checkUpload(body);
  if ('error' in share) return reply({ error: share.error }, share.error.includes('too large') ? 413 : 400);
  if (!(await deps.allow(ip))) return reply({ error: 'too many shares: try again later' }, 429);
  // A fresh code; a clash (one in 2^60) just takes another.
  for (let i = 0; i < 5; i++) {
    const code = newShareCode(deps.random);
    if (await deps.put(code, share)) return reply({ code });
  }
  return reply({ error: 'no free code' }, 503);
}
