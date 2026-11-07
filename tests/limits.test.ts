// The server's own limits against abuse (#220, server/src/limits.ts), with a fake clock.
import { describe, expect, it } from 'vitest';
import { ACCOUNTS_PER_IP_HOUR, Bucket, HELLO_MS, HOUR, MSG_BURST, MSG_RATE, ROOMS_PER_IP_HOUR, SOCKETS_PER_IP_ROOM, Windows, admit, clientIp } from '../server/src/limits';

describe('limits (#220)', () => {
  it('a socket’s message budget: a burst, then the steady rate; a flood runs out at once', () => {
    const b = new Bucket(MSG_RATE, MSG_BURST, 0);
    let ok = 0;
    for (let i = 0; i < 200; i++) if (b.take(0)) ok++;
    expect(ok).toBe(MSG_BURST);
    // A second later, MSG_RATE more.
    let later = 0;
    for (let i = 0; i < 50; i++) if (b.take(1000)) later++;
    expect(later).toBe(MSG_RATE);
  });

  it('normal play never comes near it: a roll and a move a second plus chat, for an hour', () => {
    const b = new Bucket(MSG_RATE, MSG_BURST, 0);
    for (let t = 0; t < HOUR; t += 1000) {
      expect(b.take(t)).toBe(true); // roll
      expect(b.take(t + 300)).toBe(true); // move
      if (t % 5000 === 0) expect(b.take(t + 600)).toBe(true); // a chat line
    }
    // A reconnect's burst: hello and a queued action at once.
    expect(b.take(HOUR) && b.take(HOUR)).toBe(true);
  });

  it('new accounts and rooms per IP per hour: the limit, then the next hour; other IPs aren’t affected', () => {
    const w = new Windows(ACCOUNTS_PER_IP_HOUR);
    for (let i = 0; i < ACCOUNTS_PER_IP_HOUR; i++) expect(w.hit('1.2.3.4', i)).toBe(true);
    expect(w.hit('1.2.3.4', 100)).toBe(false);
    expect(w.hit('5.6.7.8', 100)).toBe(true);
    expect(w.hit('1.2.3.4', HOUR)).toBe(true);
    expect(ROOMS_PER_IP_HOUR).toBeGreaterThanOrEqual(ACCOUNTS_PER_IP_HOUR); // a few games an hour for everyone behind one IP
  });

  it('a flood of new IPs can’t grow the counts without end', () => {
    const w = new Windows(2, HOUR, 100);
    for (let i = 0; i < 10_000; i++) w.hit(`ip${i}`, i);
    // The oldest were dropped (they start again), and the newest are still counted.
    expect(w.hit('ip9999', 10_000)).toBe(true);
    expect(w.hit('ip9999', 10_001)).toBe(false);
  });

  it('sockets per IP on one object, and a socket that never said hello is closed', () => {
    const now = 100_000;
    const open = Array.from({ length: SOCKETS_PER_IP_ROOM - 1 }, (_, i) => ({ ip: 'a', hello: true, since: now - i }));
    expect(admit(open, 'a', now, SOCKETS_PER_IP_ROOM).ok).toBe(true);
    open.push({ ip: 'a', hello: true, since: now });
    expect(admit(open, 'a', now, SOCKETS_PER_IP_ROOM).ok).toBe(false);
    // Another IP is let in.
    expect(admit(open, 'b', now, SOCKETS_PER_IP_ROOM).ok).toBe(true);
    // Silent sockets: listed to close once HELLO_MS is up, and they no longer count.
    const silent = [{ ip: 'a', hello: false, since: now - HELLO_MS }, { ip: 'a', hello: false, since: now - 1 }];
    const r = admit([...silent, ...open.slice(1)], 'a', now, SOCKETS_PER_IP_ROOM);
    expect(r.stale).toEqual([0]);
    expect(r.ok).toBe(false); // the fresh silent one still counts
    expect(admit([silent[0]!, ...open.slice(1)], 'a', now, SOCKETS_PER_IP_ROOM).ok).toBe(true);
  });

  it('the IP comes from Cloudflare’s header', () => {
    expect(clientIp(new Request('http://x/', { headers: { 'CF-Connecting-IP': '9.9.9.9' } }))).toBe('9.9.9.9');
    expect(clientIp(new Request('http://x/'))).toBe('local');
  });
});
