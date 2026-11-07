# The room server

A Cloudflare Worker with Durable Objects: private rooms, the Ranked queue and accounts, and friends. The game logic is in `src/room-core.ts`; `AGENTS.md` (at the repo root) describes every file. `npm run dev` runs it on this computer at http://localhost:8787.

## Limits against abuse (#220)

The rule: nobody can run up the bill or knock the server over, and **Cloudflare never charges extra for it**. There are three layers. Each one turns a flood away earlier, so it costs less.

1. **The WAF rule, at Cloudflare's edge (free: one rule on the Free plan).** It blocks before the Worker runs, so blocked requests are never counted as Worker requests. It only covers requests to our own domain, not `*.workers.dev`. It's set by hand in the dashboard (see below).
2. **The Workers Rate Limiting binding, in the Worker** (`RL_CONNECT`, `RL_ACCOUNT` in `wrangler.jsonc`, per IP):
   - limits: new sockets, 60 a minute; new guest accounts, 10 a minute;
   - a request it turns away has already run the Worker, but never wakes a Durable Object;
   - **switch:** the var `RATE_LIMIT_BINDING`. Unset or anything but `"0"` means on; `"0"` means off. Cloudflare publishes no price for the binding. If it ever shows up as a charge, set it to `"0"`: layer 3 still protects everything, just later in the request.
3. **Our own limits, always on** (`src/limits.ts`, tested in `tests/limits.test.ts`):
   - **Message budget per socket:** 5 a second on average, 20 at once. Over it, the socket is closed (`rate-limited`) and the app reconnects by itself. Keep-alive pings don't count; Cloudflare answers them without waking the object.
   - **Message size:** a room message is at most 2 KB, a friends or queue message 1 KB. A bigger one closes the socket.
   - **One live socket per person** per room, and per account on the friends link. A new one replaces the old (`replaced`), and the app's old connection stops. The queue already allows one search per account.
   - **Sockets per IP on one object:** 8 in a room; 20 on the friends hub or a mode's queue. A socket that hasn't said hello within 15 s is closed.
   - **New guest accounts and new private rooms per IP:** 20 and 30 an hour, counted in the Accounts object.

The numbers are generous on purpose: on mobile networks many phones share one IP (carrier NAT), and they must all still get in.

A CI test (`abuse` in `.github/workflows/pvp-staging.yml`) runs against `wrangler dev`. One client floods connections, messages, rooms and accounts while two players play a game from the same IP. The flood is cut off and the game plays on.

## The owner's part: the one WAF rule (Cloudflare dashboard)

**Before you start:**
- The production Worker (`tag-team-ludo-rooms`) needs a **custom domain**, because the WAF only covers our own domain:
  - Go to Workers & Pages → `tag-team-ludo-rooms` → Settings → Domains & Routes → Add → Custom domain.
  - Use something like `rooms.<your domain>`. That domain's zone must be on Cloudflare (the Free plan is fine).
- On the same page, **turn off the `workers.dev` route** (and Preview URLs), so nobody can reach the Worker around the rule.
- Then set the repository variable `ROOMS_URL` to `wss://rooms.<your domain>`.

**The rule:**
1. Open the dashboard. Pick the domain's zone, then go to **Security → Security rules → Create rule → Rate limiting rule**. In older dashboards this is **Security → WAF → Rate limiting rules → Create rule**.
2. **Rule name:** `Ludo server: per IP`.
3. **If incoming requests match:** choose *Custom filter expression*, then *Edit expression*, and paste:
   ```
   (http.request.uri.path in {"/ws" "/mm" "/fr" "/api/account"})
   ```
   If the editor won't take `in`, build it with the field picker instead: *URI Path* *equals* `/ws`, then **Or** the same for `/mm`, `/fr` and `/api/account`.
4. **With the same characteristics:** IP. This is fixed on the Free plan.
5. **When rate exceeds:** **20** requests per **10 seconds**. On the Free plan the period is 10 s.
6. **Then take action:** **Block**, for **10 seconds** (the Free plan's duration).
7. **Deploy.**
8. **Check:** Security → Events shows the rule's blocks. If real players get blocked (many people behind one IP), raise 20 to 40.

**The budget guard:**
- Add usage notifications on the account (Notifications → Add → Workers usage, or the billing alerts).
- Before moving to Workers Paid, check the account's Billing → Usage page: the rate limiter's `limit()` calls must not show up as a charge. If they do, set `RATE_LIMIT_BINDING` to `"0"` (see layer 2).
