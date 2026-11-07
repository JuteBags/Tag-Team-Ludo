// Shared games (#229): SQLite-backed Durable Objects, one per code's first character ("shares:<c>"), each keeping
// its codes' records and review summaries. The logic and the checks are in shares-core.ts; index.ts routes
// /api/share. A share is kept a year after it was last opened; a daily alarm forgets older ones.
import { DurableObject } from 'cloudflare:workers';
import { KEEP_SHARE_MS, type Share, type ShareStore } from './shares-core';

const DAY = 24 * 3_600_000;

export class Shares extends DurableObject {
  private store: ShareStore;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS shares (code TEXT PRIMARY KEY, rec TEXT NOT NULL, sum TEXT, opened INTEGER NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS shares_opened ON shares (opened)');
    this.store = {
      put: (code, share, now) => {
        if (sql.exec('SELECT 1 FROM shares WHERE code = ?', code).toArray().length) return false;
        sql.exec('INSERT INTO shares (code, rec, sum, opened) VALUES (?, ?, ?, ?)', code, share.rec, share.sum, now);
        return true;
      },
      get: (code, now) => {
        const row = sql.exec<{ rec: string; sum: string | null; opened: number }>('SELECT rec, sum, opened FROM shares WHERE code = ?', code).toArray()[0];
        if (!row || now - row.opened >= KEEP_SHARE_MS) return null;
        // Opening it keeps it another year; written at most once a day (a row write each time would cost).
        if (now - row.opened >= DAY) sql.exec('UPDATE shares SET opened = ? WHERE code = ?', now, code);
        return { rec: row.rec, sum: row.sum };
      },
      sweep: (before) => sql.exec('DELETE FROM shares WHERE opened < ?', before).rowsWritten,
    };
  }

  /** Keeps a new share (false: the code is taken). */
  async put(code: string, share: Share): Promise<boolean> {
    const ok = this.store.put(code, share, Date.now());
    if (ok && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + DAY);
    return ok;
  }

  /** A share by its code, or null. */
  async get(code: string): Promise<Share | null> {
    return this.store.get(code, Date.now());
  }

  /** Once a day: forget the shares nobody opened for a year. */
  async alarm() {
    this.store.sweep(Date.now() - KEEP_SHARE_MS);
    await this.ctx.storage.setAlarm(Date.now() + DAY);
  }
}
