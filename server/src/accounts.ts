// Ranked accounts: one Durable Object (named "global") holding every guest account in SQLite, with one rating
// per mode. A guest account is made on the device's first ranked visit; its secret stays on the device and
// only its SHA-256 is kept here. Google sign-in can later attach to the same account id.
import { DurableObject } from 'cloudflare:workers';
import { GAME_MODES, type AccountKey, type AccountReply, type GameMode, type ModeRating } from '../../src/net/protocol';
import { PROVISIONAL, START_RATING, rate } from '../../src/net/rating';
import type { RateReport, RatedPerson } from './room-core';
import { cleanName } from './room-core';

const fresh = (): Record<GameMode, ModeRating> => Object.fromEntries(GAME_MODES.map((m) => [m, { rating: START_RATING, games: 0, wins: 0 }])) as Record<GameMode, ModeRating>;
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const KEY = /^[0-9a-f]{32}$/;

interface Row {
  id: string;
  secret: string;
  name: string;
  ratings: string;
  [k: string]: SqlStorageValue;
}

export class Accounts extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, secret TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL, ratings TEXT NOT NULL)');
  }

  private row(id: string): Row | null {
    return this.ctx.storage.sql.exec<Row>('SELECT id, secret, name, ratings FROM players WHERE id = ?', id).toArray()[0] ?? null;
  }

  private ratingsOf(row: Row): Record<GameMode, ModeRating> {
    // Modes added later start fresh.
    return { ...fresh(), ...(JSON.parse(row.ratings) as Partial<Record<GameMode, ModeRating>>) };
  }

  /** The account for `key` (null when it's unknown or the secret is wrong). */
  async check(key: AccountKey): Promise<{ name: string; ratings: Record<GameMode, ModeRating> } | null> {
    if (!key || !KEY.test(key.id ?? '') || !KEY.test(key.secret ?? '')) return null;
    const row = this.row(key.id);
    if (!row || row.secret !== (await sha(key.secret))) return null;
    return { name: row.name, ratings: this.ratingsOf(row) };
  }

  /** The account, made when `key` is null; the name is updated. Null for a key that doesn't check out. */
  async account(key: AccountKey | null, name: string): Promise<AccountReply | null> {
    const clean = cleanName(name);
    if (key) {
      const known = await this.check(key);
      if (!known) return null;
      if (known.name !== clean) this.ctx.storage.sql.exec('UPDATE players SET name = ? WHERE id = ?', clean, key.id);
      return { id: key.id, secret: key.secret, name: clean, ratings: known.ratings };
    }
    const id = hex(crypto.getRandomValues(new Uint8Array(16)));
    const secret = hex(crypto.getRandomValues(new Uint8Array(16)));
    const ratings = fresh();
    this.ctx.storage.sql.exec('INSERT INTO players (id, secret, name, created, ratings) VALUES (?, ?, ?, ?, ?)', id, await sha(secret), clean, Date.now(), JSON.stringify(ratings));
    return { id, secret, name: clean, ratings };
  }

  /**
   * Tests only (TEST_HOOKS, never set in wrangler.jsonc): sets an account's rating and games in one mode, so a
   * test can search from any league. Null for a key that doesn't check out.
   */
  async testSetRating(key: AccountKey, mode: GameMode, rating: number, games: number): Promise<boolean> {
    if (!GAME_MODES.includes(mode) || !(await this.check(key))) return false;
    const row = this.row(key.id)!;
    const ratings = this.ratingsOf(row);
    ratings[mode] = { rating, games, wins: 0 };
    this.ctx.storage.sql.exec('UPDATE players SET ratings = ? WHERE id = ?', JSON.stringify(ratings), key.id);
    return true;
  }

  /** Rates a finished ranked game: every account's new rating in its mode (bots aren't stored). */
  async rate(report: RateReport): Promise<Record<string, RatedPerson>> {
    const mode = report.mode;
    const rows = new Map<string, { row: Row; ratings: Record<GameMode, ModeRating> }>();
    for (const side of report.sides)
      for (const m of side.members)
        if ('account' in m && !rows.has(m.account)) {
          const row = this.row(m.account);
          if (row) rows.set(m.account, { row, ratings: this.ratingsOf(row) });
        }
    const ratingOf = (m: { account: string } | { bot: number }) => ('bot' in m ? m.bot : (rows.get(m.account)?.ratings[mode].rating ?? START_RATING));
    const gamesOf = (m: { account: string } | { bot: number }) => ('bot' in m ? PROVISIONAL : (rows.get(m.account)?.ratings[mode].games ?? 0));
    const deltas = rate(report.sides.map((s) => ({ ratings: s.members.map(ratingOf), games: s.members.map(gamesOf), place: s.place })));
    const out: Record<string, RatedPerson> = {};
    report.sides.forEach((side, i) =>
      side.members.forEach((m, j) => {
        if (!('account' in m)) return;
        const r = rows.get(m.account);
        if (!r || out[m.account]) return;
        const now = r.ratings[mode];
        const after = Math.max(0, now.rating + deltas[i]![j]!);
        out[m.account] = { before: now.rating, after, games: now.games + 1 };
        r.ratings[mode] = { rating: after, games: now.games + 1, wins: now.wins + (side.place === 0 ? 1 : 0) };
        this.ctx.storage.sql.exec('UPDATE players SET ratings = ? WHERE id = ?', JSON.stringify(r.ratings), m.account);
      }),
    );
    return out;
  }
}
