// Shared games as short links (#229): the game goes up to our server once (server/src/shares-core.ts), and the link
// carries only its code: <site>/play/#g=<code>. The record is the shared one (replay.ts forSharing: colours in place
// of people's names); the review summary is the sharer's own, packed as it is (the server never reads it, and the
// viewer's app can always work the review out again from the record).
import { decodeRecord, encodeRecord, packJson, unpackJson, type GameRecord } from '../engine';
import { roomsUrl } from './client';

/** The server's HTTP address (the room server's WebSocket address, as http). */
const httpBase = () => roomsUrl().replace(/^ws/, 'http');
/** Kept under the server's caps (shares-core.ts MAX_SHARE_SUM): a bigger summary isn't sent. */
const MAX_SUM = 48_000;
/** How long Share waits for the server before it falls back to the long link. */
const UPLOAD_MS = 6000;

const timed = (ms: number) => {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
};

/** Uploads a shared record (already forSharing'd) and its review summary; the code, or null (no server, offline, refused). */
export async function uploadShare(rec: GameRecord, summary?: unknown): Promise<string | null> {
  if (!roomsUrl() || (typeof navigator !== 'undefined' && navigator.onLine === false)) return null;
  try {
    const sum = summary === undefined ? undefined : await packJson(summary);
    const body = JSON.stringify({ rec: await encodeRecord(rec), ...(sum && sum.length <= MAX_SUM ? { sum } : {}) });
    const res = await fetch(`${httpBase()}/api/share`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: timed(UPLOAD_MS) });
    if (!res.ok) return null;
    const { code } = (await res.json()) as { code?: unknown };
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

/** A shared game by its code: the record and the sharer's summary (undefined without one); null when it can't be had. */
export async function fetchShare(code: string): Promise<{ rec: GameRecord; summary: unknown } | null> {
  if (!roomsUrl()) return null;
  try {
    const res = await fetch(`${httpBase()}/api/share/${encodeURIComponent(code)}`, { signal: timed(15_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { rec?: unknown; sum?: unknown };
    const rec = typeof body.rec === 'string' ? await decodeRecord(body.rec) : null;
    if (!rec) return null;
    const summary = typeof body.sum === 'string' ? await unpackJson(body.sum) : undefined;
    return { rec, summary: summary ?? undefined };
  } catch {
    return null;
  }
}
