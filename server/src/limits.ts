// Limits against abuse (#220): nobody can run up the bill or knock the server over. Pure, so tests/limits.test.ts
// drives them with a fake clock. These always run in our own server, whatever Cloudflare offers:
//   - each socket has a message budget (a token bucket); going over closes it (`rate-limited`);
//   - each message has a size cap (MAX_MESSAGE in each object); a bigger one closes the socket;
//   - one live socket per person per room, and per account on the friends link (a new one replaces the old);
//   - each IP may hold only so many sockets on one object, and a socket that doesn't say hello in time is closed;
//   - each IP may make only so many guest accounts and private rooms an hour.
// In front of these, when it's on, the Workers Rate Limiting binding (index.ts, RATE_LIMIT_BINDING) turns
// floods away in the Worker before they reach an object, and the one WAF rule (set in the dashboard, see
// server/README.md) turns them away before the Worker.

/** A socket's message budget: MSG_RATE a second on average, MSG_BURST at once. Pings don't count (auto-answered). */
export const MSG_RATE = 5;
export const MSG_BURST = 20;
/** Sockets one IP may hold on one Durable Object: a room (4 people, a reconnect each), or the friends hub / a queue. */
export const SOCKETS_PER_IP_ROOM = 8;
export const SOCKETS_PER_IP_HUB = 20;
/** A socket that hasn't said hello this long after opening is closed (it holds a connection and does nothing). */
export const HELLO_MS = 15_000;
/**
 * New guest accounts and new private rooms per IP per hour. Generous on purpose: many phones share one IP on mobile
 * networks (carrier NAT), and those people must still get in.
 */
export const ACCOUNTS_PER_IP_HOUR = 20;
export const ROOMS_PER_IP_HOUR = 30;
export const HOUR = 3_600_000;

/** A token bucket: `take` spends one token if there is one; tokens come back at `rate` a second, up to `burst`. */
export class Bucket {
  private tokens: number;
  private at: number;
  constructor(private rate = MSG_RATE, private burst = MSG_BURST, now = 0) {
    this.tokens = burst;
    this.at = now;
  }
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Counts per key in fixed windows (an hour for accounts and rooms): `hit` counts one and says whether it's within
 * `limit`. At most `maxKeys` keys are kept (the oldest windows go first), so a flood of new IPs can't grow it.
 */
export class Windows {
  private counts = new Map<string, { from: number; n: number }>();
  constructor(private limit: number, private windowMs = HOUR, private maxKeys = 50_000) {}
  hit(key: string, now: number): boolean {
    let c = this.counts.get(key);
    if (!c || now - c.from >= this.windowMs) {
      this.counts.delete(key);
      c = { from: now, n: 0 };
      if (this.counts.size >= this.maxKeys) this.counts.delete(this.counts.keys().next().value!);
      this.counts.set(key, c);
    }
    c.n++;
    return c.n <= this.limit;
  }
}

/** The caller's IP, as Cloudflare gives it (it can't be set by the caller); "local" when there's none (tests). */
export const clientIp = (req: Request) => req.headers.get('CF-Connecting-IP') ?? 'local';

/**
 * Whether a new socket from `ip` may open on an object that already holds `open` (each socket's IP, whether it
 * said hello, and when it opened). Sockets that never said hello within HELLO_MS are listed in `stale` to close.
 */
export function admit(open: { ip: string; hello: boolean; since: number }[], ip: string, now: number, cap: number): { ok: boolean; stale: number[] } {
  const stale = open.flatMap((s, i) => (!s.hello && now - s.since >= HELLO_MS ? [i] : []));
  const mine = open.filter((s, i) => s.ip === ip && !stale.includes(i)).length;
  return { ok: mine < cap, stale };
}
