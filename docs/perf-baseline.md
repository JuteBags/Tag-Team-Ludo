# Performance baseline (#98)

The numbers every later `perf:` PR measures against. **Part 1 (this file so far) needs no device:**
- the bundle and what loads at startup;
- a static audit of what can run while a screen is idle;
- a static audit of paint cost.

**CI measurements: §4** (headless Chrome, throttled, on every `perf:` PR). **Phone measurements: §5, pending.**

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
  - **After #111** (CI build): replay, review (with reviewText), store, bench, the palace cutscene and the share card load on first use and are prefetched at idle. Startup JS (index + the preloaded `board` and `rules` chunks) went **259.2 → 205.3 kB raw (−21%), 86.1 → 69.0 kB gzip (−20%)**. The lazy chunks total 58.2 kB raw, of which palace is 20.6.
- **The Extreme net ships twice.** It's the same `extreme-net.json`, bundled once for the main thread (`src/engine/ai/levels.ts:21`) and once inside the worker (`rollout-worker.ts:17`, `:29`): 2 × 560 kB raw in the APK. Each is a JS array literal, so it's parsed as JS: one copy in the UI thread's heap, one in the worker's.
  - **After #114:** one `extreme-net-*.bin` (419 kB, Float64, bit-identical to the JSON) shared by the worker and the fallback, and no JS copies. APK 4,636,352 → 4,573,535 bytes (−63 kB). Worker net load + engine init, measured in Node on the CI builds: **23–26 ms → 2.2–2.4 ms**, JS heap kept 1.54 → 0.12 MB, wasm memory 3.8 → 2.1 MB. The web's first-use download of the net may grow (419 kB binary against 229 kB of gzipped JS) if Pages doesn't compress `.bin`; Float32 (209 kB) stays a measured follow-up. Device check: pending (#98).
  - **After the Float32 net (#98):** `extreme-net.bin` holds the weights as Float32: **419 → 210 kB raw, 389 → 190 kB gzip**, so the web's first Extreme download is about 200 kB smaller, more than winning back #114's +190 kB. Measured on CI with the same seeds (`net-f32.yml`): Extreme vs Hard identical in all 10 modes, 7,368/7,368 review labels and Extreme choices unchanged, and accuracy within 5e-7 points, so REVIEW_VERSION wasn't bumped.
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

## 4. CI baseline: the app's screens in headless Chrome

The numbers every `perf:` PR compares against: the PR runs the same script before and after its change.

- **Script:** `tools/perf/screens.mjs`.
- **Workflow:** `.github/workflows/perf-screens.yml`. It runs by hand (`gh workflow run perf-screens.yml --ref <branch>`), and on a PR labelled `performance` that touches `src/ui/**`.
- **Run:** 41874446199, on commit `8914178` (PR #157's merge of `50240de` into main).
- **Runner:** GitHub `ubuntu-latest`, 4 vCPUs, Google Chrome 156.0.8078.47, headless.
- **Settings:**
  - the production build (`vite preview`);
  - 390×844 at DPR 2;
  - CPU throttled **4×**, as a proxy for a mid-range phone;
  - 1.5 s to settle, then **10 s with no input** per screen (0.3 s to settle for the bots' turns).
- **Measures:**
  - JS heap and DOM nodes, from `Performance.getMetrics`;
  - frames drawn (`DrawFrame`) and main-thread paints (`Paint`), from a trace;
  - main-thread task time and its script, style and layout parts, in ms per second, from the `getMetrics` deltas.

**Cold start** (a fresh context, to the home screen):

| | |
|---|---:|
| first contentful paint | 572 ms |
| DOMContentLoaded / load | 522 / 524 ms |
| home screen interactive | 1219 ms |
| fetched | 141 kB |

The home-interactive time is when the script saw the vs Computer button visible. It includes Playwright's polling, so treat it as ±50 ms.

**Per screen:**

| screen | JS heap used / total (MB) | DOM nodes | frames/s | paints/s | main-thread task ms/s | script | style | layout |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| home | 2.85 / 4.87 | 2226 | 0 | 0 | 2.2 | 0.2 | 0 | 0 |
| setup | 3.21 / 5.37 | 3276 | 0 | 0 | 0.2 | 0.1 | 0 | 0 |
| game, waiting for the roll | 3.61 / 4.23 | 4150 | 60 | 0 | 7.7 | 0.2 | 0 | 0 |
| game, waiting for the move | 4.14 / 4.73 | 4391 | 44 | 0.2 | 2.4 | 0.1 | 0.1 | 0 |
| game, the bots' turns | 3.98 / 4.98 | 4445 | 54.7 | 72.4 | 238.2 | 5 | 13.4 | 15.8 |
| replay | 5.1 / 7.48 | 5754 | 0 | 0 | 0.2 | 0.1 | 0 | 0 |
| review (finished) | 5.73 / 10.73 | 8798 | 0 | 0 | 0.7 | 0 | 0 | 0 |
| store | 5.1 / 9.35 | 3298 | 0 | 0 | 0.2 | 0 | 0 | 0 |

How each screen is set up:
- **The game:** a saved 4-player vs Computer game (Hard bots), opened with Continue, with the person to roll and three tokens out.
- **Waiting for the move:** after the roll.
- **The bots' turns:** after a tap on a landing marker.
- **The replay and the review:** the seed-24 game's share link (`tools/perf/game-seed24.link.txt`), reviewed to the end.

**Largest chunks** (from `dist/`):

| chunk | raw kB | gzip kB |
|---|---:|---:|
| ludo_wasm.wasm | 303.2 | 109.1 |
| extreme-net.bin | 205.0 | 189.8 |
| index.js | 135.4 | 45.6 |
| index.css | 74.7 | 16.1 |
| art.js | 42.3 | 12.7 |
| rollout-worker.js | 29.0 | 11.0 |
| reviewQueue.js | 23.8 | 9.6 |
| palace.js | 20.1 | 6.7 |
| nunito 900 / 800 (woff2) | 16.3 / 16.1 | 16.3 / 16.2 |
| replayScreen.js | 13.4 | 5.7 |
| reviewScreen.js | 13.0 | 5.1 |

The wasm and the nets are not fetched at startup: the cold start fetched 141 kB.

**What it shows:**
- **Settled screens are quiet.** Home, setup, replay, the finished review and the store all draw 0 frames and use under 2.5 ms/s of main thread. Section 2 predicted this for home; it now holds for those five screens.
- **The bots' turns are the one busy screen:** 238 ms/s of main thread, almost a quarter of it, with 72 paints/s. Script is only 5 ms/s, because the bots think in the worker. The rest is rendering. My first guess was the hops: every hop, throw and squash is a rAF `tween` that sets an SVG `<g>`'s `transform` attribute (`boardView.ts`, `set`). The target-1 probe below shows the hops are only a small part of it.
- **The game keeps drawing while it waits for the person:**
  - 60 frames/s while waiting for the roll (I5 `nudge`);
  - 44 frames/s while waiting for the move (I2 `bob`).

  Both are compositor-only here, with no main-thread paints (0 and 0.2/s). So I2's "SVG repaints" flag does not hold in Chrome 156, and I3's trail was not on show in this run. The bob already stops after 9 s without input (`calm.ts`, `CALM_MS`): the 44/s is about 7.5 s of bobbing in the 10 s window. The roll nudge is left out of the calm on purpose, so it runs for as long as the person waits. That costs GPU and compositor frames, which is battery on a phone, and CI can't price it.
- **The review is the heaviest screen:** 8.8k DOM nodes against the replay's 5.8k, and a 10.7 MB heap total. The store (3.3k nodes) still has a 9.35 MB heap total right after it, because nothing collected the garbage yet. This is not a leak by itself; a phone run would confirm it.

## 5. Needs a real ARM phone

Headless Chrome on an x86 runner can't measure these. They need the owner's phone (as in #89), or MuMu once memory allows:
- **Absolute memory:** the Android WebView's PSS (total, Java heap, native, graphics) from `dumpsys meminfo`, not Chrome's JS heap.
- **True CPU cost:** a 4× throttle on x86 is only a proxy for a mid-range ARM core, and the wasm engine's speed differs most (#151's bench).
- **Battery:** 10 minutes of a game against 10 minutes idle. This is the only way to price the idle compositor frames in §4.
- **Frame pacing:** dropped and janky frames during the bots' turns and the kill effects, on a real GPU, rather than the frame count.
- **Cold start with the WebView's start-up and the APK:** `am start -W`, plus first paint inside the app.
- **Detached DOM nodes** after leaving the review and the replay, from a DevTools heap snapshot on the device.

Screens: as in §4, plus a game vs Extreme, the result, and the review while it runs (the CI numbers are for the finished review).

The flags in section 2 (I1–I8) and the targets from §4 are what the device traces should confirm first.

### Target 1 probe: where the bots' turns' paints go

These runs use the script's layer and main-thread columns. The saved game is seeded, so every run plays the same bots' turns. All runs are on 4 vCPUs with Chrome 156, throttled 4×, on 2026-11-04.

| variant | commit | paints/s | board (`div.binner`) | root layer (`#document`) | action bar (`div.act`) |
|---|---|---:|---:|---:|---:|
| main (the hops a rAF loop on the `transform` attribute) | `927b31e` | 70.7 | 18.0/s | 29.5/s | 9.2/s |
| B1: a CSS `transform` with `will-change` on the pawns | `b48cc75`, `88eaf14` | 70.7 | 18.0/s | 29.4/s | 9.2/s |
| B2: the hops, throws and squashes as Web Animations | `fb0ca8a` | 67.2 | 16.6/s | 27.6/s | 9.1/s |

- **The hops are not the cost.**
  - B1 changes nothing: Chrome doesn't give an SVG child its own layer.
  - B2 is composited, and saves 5 % of the paints.
  - The board is a quarter of the paints. The root layer (the HTML around the board: the corners, the hint) and the action bar (the dice tray) are more than half.
- **Main-thread self time** (`927b31e`; extra trace categories inflate it):
  - layerization (`PaintArtifactCompositor::Update`) 44 ms/s;
  - paint 38;
  - style 16;
  - hit testing 14 (the mouse rests on the board after the tap; a phone has no hover);
  - pre-paint 12;
  - script 11;
  - layout 10;
  - commit 10.

  Each move brings many one-off changes, each with its own small cost.
- **Per frame:** 4–6 ms of main thread at 4×, inside the 16.7 ms budget. The same code measured 208–332 ms/s across runs, so only the counts compare between runs.
- **Verdict:** target 1 is parked. A real phone's frame pacing during the bots' turns (§5) decides whether it's worth more. If it is, the next step is what repaints the root layer and the action bar on each bot turn, not the hops.
