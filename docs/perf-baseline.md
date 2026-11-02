# Performance baseline (#98)

The numbers every later `perf:` PR measures against. **Part 1 (this file so far) needs no device:**
- the bundle and what loads at startup;
- a static audit of what can run while a screen is idle;
- a static audit of paint cost.

**Device measurements: pending instance 1.** These are memory (PSS, JS heap), idle and in-game CPU traces, frames painted while idle, cold start and battery. On MuMu instance 1 the app currently opens on a separate host screen that captures black, so the device half waits for that to be fixed. Real-phone numbers come from the owner, as in #89.

Commit measured: `a4184f9` (main, after #102). Build: `build.yml` run 41400098043 (its `web` and `android` artifacts, not a local build).

## 1. Bundle and startup

Sizes are from the `dist/` that CI built, with gzip at level 9. The APK is the release `tag-team-ludo.apk` (versionCode 201).

| File | Raw | Gzip | Loads |
|---|---:|---:|---|
| `index-*.js` (the app) | 259.3 kB | 86.1 kB | **startup** |
| `index-*.css` | 71.0 kB | 15.2 kB | **startup** |
| `nunito-latin-900` woff2 | 16.7 kB | (woff2) | startup, on first use |
| `nunito-latin-800` woff2 | 16.5 kB | (woff2) | startup, on first use |
| `lilita-one-latin-400` woff2 | 10.7 kB | (woff2) | startup, on first use |
| `extreme-net-*.js` (main thread) | 559.6 kB | 228.6 kB | lazy: `loadExtreme()` |
| `rollout-worker-*.js` | 24.4 kB | 9.4 kB | lazy: the first Extreme move or review |
| `extreme-net-*.js` (worker copy) | 559.6 kB | 228.7 kB | lazy, inside the worker |
| `ludo_wasm-*.wasm` | 295.3 kB | 106.3 kB | lazy, inside the worker |
| `web-*.js` (4 Capacitor web shims) | 10.8 kB | 4.1 kB | lazy |
| **APK** | **4.64 MB** | | (AAB 4.47 MB) |

**At startup:** about 101 kB gzip of JS and CSS, plus 44 kB of fonts. That's 330 kB of JS and CSS to parse.

What stands out:
- **No code splitting.** One 259 kB chunk carries every screen: home, setup, game, result, store, replay, review, the bench page, the palace cutscenes and the check-in. Strings from each are in `index-*.js` ("SHARE GAME", "Find the better move", "Ember Keep", `#bench`, "This link is broken"). The issue's estimate of 190 kB is now 259 kB, after the review screens landed.
- **The Extreme net ships twice.** It's the same `extreme-net.json`, bundled once for the main thread (`src/engine/ai/levels.ts:21`) and once inside the worker (`rollout-worker.ts:17`, `:29`): 2 × 560 kB raw in the APK. Each is a JS array literal, so it's parsed as JS: one copy in the UI thread's heap, one in the worker's.
- **The main-thread net loads in almost every Extreme game.** `chooseBotMoveAsync` (`levels.ts:62`) sends only multi-move decisions to the worker. For a forced move (one legal move) it falls through to `await loadExtreme()` (`levels.ts:73`), which imports and parses the 560 kB net on the UI thread to "choose" the only move. The net then stays in memory for the rest of the session.
  - **After #108** (measured in tests, fake worker: `tests/extremeWorker.test.ts`): over 3 seeded 4-player Extreme games (769 real choices, 360 forced moves), the UI thread imported the net **once before, 0 times after**. The worker got all 769 real choices both times, so Extreme plays the same. One import keeps **1.4 MB** of heap alive (the JSON module alone, measured in Node 24 on the CI chunk), plus the parse of 560 kB of JS mid-game. Device check: pending (#98).
- **Fonts are latin-only already** (3 files, 44 kB in all), and `@dicebear` isn't in the runtime bundle (it's build-time only: no match in `index-*.js`).
- **The WASM (295 kB) and the rollout worker load only on demand**, as they should.

## 2. Idle audit: what can run while nothing changes

**No `setInterval` anywhere in `src/`.** Every `requestAnimationFrame` loop is bounded:
- `boardView.ts:46-55`: a move's animation, ends at `ms`, with a `setTimeout` fallback;
- `gameScreen.ts:838-848`: the result's gold count-up, 900 ms.

The other timers are one-shots tied to an animation or a toast. The replay's autoplay chain (`replayScreen.ts:313-316`) stops when the screen leaves the DOM or the game ends. The palace cutscene clears its timers on finish (`palace.ts:327-340`).

Listeners for the whole app's lifetime (fine, but listed):

| Where | Listener |
|---|---|
| `app.ts:130` | `hashchange` (share links) |
| `native.ts:16` | `keydown` (Escape as Back on the web) |
| `native.ts:23`, `native.ts:45` | `visibilitychange` (pause and save; wake lock) |
| `reviewQueue.ts:208` | `visibilitychange` (pause the review when hidden) |
| `sfx.ts:25` | `pointerdown`, capture: every tap calls `ac()` |

Per-screen listeners are attached to the screen's own elements and go with them. The game screen's `visibilitychange` (`gameScreen.ts:132`) is removed in `dispose` (`:687`), and the bench's (`bench.ts:100`) on finish (`:132`).

**Flags: work that can run while the screen is idle**

| # | Screen | What | Where | Why it matters |
|---|---|---|---|---|
| I1 | every screen, after the first tap | **The AudioContext is never suspended.** It's created on the first tap and resumed on every tap, but nothing suspends it after a sound or when the app goes to the background. | `sfx.ts:12-20`, `:25` | A running context keeps the audio thread rendering silence: CPU wake-ups and battery on idle screens. Suspend after ~2 s without a sound, and on `visibilitychange`. | **Fixed in #109:** it sleeps 5 s after the last sound ends, and at once when hidden or muted. Measured in tests (fake clock, `tests/sfx.test.ts`): running **4 s of a 60 s idle minute** after one sound, against 60 of 60 before. Device check: pending (#98).
| I2 | game, waiting for the human | `.pawn.movable .pawn-art` bobs forever (transform on an **SVG** element) | `styles.css:148` (`bob`) | SVG transforms are generally repainted, not composited, so the board SVG repaints every frame for as long as the player thinks. |
| I3 | game, waiting for the human | the move preview's dotted trail marches forever (`stroke-dashoffset`) | `styles.css:378` (`march`), drawn at `boardView.ts:359` | A paint property: the board repaints every frame while the trail shows. |
| I4 | game, any time the inferno dice skin is on | the inferno pips glow forever (animated `box-shadow`) | `styles.css:118-119` (`ember`) | `box-shadow` animation repaints every frame, even with the dice at rest. |
| I5 | game, waiting to roll | the dice box and roll button pulse (`transform: scale`) | `styles.css:238`, `:247` (`nudge`) | HTML transform: compositor-only, cheap. Listed so the device trace can confirm. |
| I6 | review, until the luck arrives | the skeleton shimmers (`background-position`) | `styles.css:769-771` (`shimmer`), `reviewScreen.ts:129` | Repaints every frame, but only until the luck job answers. |
| I7 | replay and review, best-move ghost shown | the ghost's ring pulses (transform and opacity on an SVG circle) | `styles.css:834-835` (`gpulse`), `boardView.ts:177` | SVG again: likely repainted every frame while the ghost is up. |
| I8 | Extreme games | the 560 kB net is parsed on the UI thread for forced moves | `levels.ts:62-73` (see §1) | Memory and a parse stall mid-game. | **Fixed in #108:** forced moves skip the engine.

**Home screen idle:** no timer, no rAF, no infinite animation. It should paint nothing once settled (to confirm on the device).

## 3. Paint-cost audit (static)

`styles.css` (901 lines):

| Property | Rules |
|---|---:|
| `box-shadow` | 110 |
| gradients | 91 |
| `filter` / `drop-shadow` | 25 / 15 |
| `backdrop-filter` | 0 |
| infinite animations | 7 (§2) |

**Blur filters** are the most expensive static paints:

| Where | What | Screen |
|---|---|---|
| `styles.css:145` | `.gboard::after`, `blur(14px)` under the board | game, replay, review |
| `styles.css:172` | the hero glow, `blur(6px)` | home |
| `styles.css:77` | `.diew .dsh`, blurred die shadow | game, store |

**`drop-shadow` on SVG** (re-rasterised whenever the SVG repaints, which with I2/I3 is every frame):

| Where | What |
|---|---|
| `styles.css:36` | `.ltrail`, the last-move trail on the board |
| `styles.css:367` | `.mark .pill`, the landing markers on the board |
| `:93`, `:98`, `:100`, `:252` | dice cups and tray dice |
| `:174`, `:175` | home hero dice |
| `:227`, `:229` | turn pointer and colour symbols |
| `:320`, `:323`, `:327` | result: trophy, stars, ribbon |
| `:436`, `:488` | setup pawns |

**Large or many-layer `box-shadow`** (blur ≥ 16 px or ≥ 4 layers: 30 rules), the biggest being:

| Where | What | Screen |
|---|---|---|
| `:358` | `.killflash`, inset 140 px blur over the whole board | game, on a capture (short-lived) |
| `:16` | Tron theme's `.bframe`, 6 layers up to 40 px | game, Tron theme |
| `:132` | `.bframe`, 5 layers up to 40 px | game, replay, review |
| `:237`, `:222` | `.pl.active .dbox` (4 layers, 26 px) and `.pl.active .av` (22 px) | game, the active player's corner |
| `:280`, `:390`–`:394`, `:494` | the toasts (30 px) | game, short-lived |
| `:284`, `:331` | `.menu-ov .box`, `.rank` (30 px) | game menu, result |
| `:195`, `:72`, `:73` | `.tile`, `.b3.blue/.green` (20 px) | home |
| `:402`, `:431`, `:490` | `.mcard`, `.wiz .quick`, `.house.can` | setup |
| `:527`, `:547` | `.cont`, `.storerow` | home |
| `:700` | `.sharebtn` | result, replay |

Static shadows cost once per paint, not per frame. They matter mostly when the same layer also repaints for an animation: the board frame (`.bframe`) and the active player's corner sit next to I2–I4.

## 4. What the device half will measure (pending)
Per the issue, on MuMu instance 1 (once it shows the app on display 0):
- `dumpsys meminfo` PSS: total, Java heap, native, graphics;
- DevTools heap and detached nodes;
- 30 s idle and in-game traces with a count of frames painted;
- `am start -W` cold start;
- 10-minute battery: game against idle.

Screens:
- home idle;
- setup;
- a game vs Hard;
- a game vs Extreme;
- the result;
- the replay;
- the review running;
- the store.

The flags above (I1–I8) are what the traces should confirm or rule out first.
