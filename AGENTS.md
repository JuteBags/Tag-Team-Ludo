# AGENTS.md

HTML5 Ludo game for web and Android (APK via Capacitor) from one codebase. v1 is one human against 1-3 bots, offline. Multiplayer (online and private rooms) comes in a later update.

## Stack

- TypeScript, tested with Vitest, built with Vite.
- Renderer: SVG/DOM, ported from the approved mockup in `mockups/index.html` (SVG board, CSS 3D dice). No canvas, no images: all art is vector code.
- Fonts are self-hosted via `@fontsource` (Lilita One, Nunito) so the app works offline.
- Capacitor 8 wraps the same build into the Android app (`android/`, app ID `com.jutebags.ludo`, portrait only, minSdk 24 = Android 7.0).
- GitHub Actions (`.github/workflows/build.yml`) builds and ships everything; see "Build and release" below.
- No game framework: Phaser/PixiJS were considered and dropped because they would mean rebuilding the mockup art as textures.

## Layout

- `docs/RULES.md` — the source of truth for every game rule, including the pair (jodi) rule and the weighted dice. Change it together with the engine.
- `src/engine/` — pure rules engine, no DOM:
  - `board.ts` constants and progress → square mapping
  - `rules.ts` legal moves, pairs/blocks, captures, threats
  - `dice.ts` weighted dice (weights in eighteenths)
  - `game.ts` turn flow (`newGame`, `roll`, `move`, `finalRanking`)
  - `bot.ts` single-level heuristic bot (`chooseMove`, `botStep`)
  - `rng.ts` seeded RNG for tests, `cryptoRng` for real play
- `src/ui/` — the game UI (DOM + SVG), driven by the engine:
  - `app.ts` fixed 390 x 844 stage scaled to fit any screen, routing home ↔ game
  - `art.ts` all vector art (board, pawns, avatars, trophy) and the shared SVG `<defs>`
  - `geometry.ts` board cell coordinates; track order must match `src/engine/board.ts`
  - `boardView.ts` pawn placement, stacking, pair badges, hop/capture animations
  - `dice.ts` CSS 3D die and roll animation
  - `gameScreen.ts` turn loop, bot pacing, human taps, pair chooser, pause menu, result screen
  - `homeScreen.ts` home screen (Online/Private tiles are locked placeholders)
- `tests/` — Vitest specs: rules, turn flow, dice (incl. Monte Carlo), bot simulations.
- `mockups/` — static UI mockup and its PNG screenshots.
- `docs/` — the public website (GitHub Pages): `index.html` plus `assets/`. `docs/RULES.md` lives here too but CI leaves it out of the site because it contains the dice weighting.
- `android/` — Capacitor Android project. Signing and version come from CI (`android/app/build.gradle`).
- `assets/` — app icon sources (`icon-background.svg`, `icon-foreground.svg`); `tools/render-icons.ps1` renders them into `android/.../res` with headless Edge.

## Engine conventions

- State is immutable: every function returns a new `GameState`/`PlayerState[]`.
- A token is a single number, its **progress**: `-1` base, `0-50` track, `51-55` home column, `56` finished. `squareOf(color, progress)` gives the shared track square.
- Randomness is always injected (`Rng`), so tests and replays are deterministic.
- The weighted dice apply to every player, bots included.

## UI conventions

- The UI never decides rules: it calls `roll`/`move` and animates the resulting state.
- A game ends for the human as soon as they finish all tokens (or are the last one left); others are ranked by `finalRanking`.
- Animations use rAF with a `setTimeout` fallback, so a stalled WebView can never hang a turn.
- Dev only: `window.__ludo` is the running `GameScreen` (`forced` dice queue, `speed` multiplier) for testing.

## Build and release

Repo: https://github.com/JuteBags/Ludo-game · site: https://jutebags.github.io/Ludo-game/

- Push to `main` → tests, web build, signed APK, then the Pages site is assembled from `docs/` + the game at `/play/` + the APK at `/download/ludo.apk` (with `download/version.json`).
- Push a tag `vX.Y.Z` → signed APK + AAB attached to a GitHub Release (`-suffix` tags are pre-releases). Pages only deploys from `main`.
- `versionCode` = workflow run number; never rename `build.yml` or it restarts at 1.
- Release key: `~/ludo-signing/` (`ludo-release.jks`, `keystore.properties`), alias `ludo`, SHA-256 `7A:B3:6E:10:…:1A:A4`. It is PKCS12, so the key password is the same as the store password. CI reads it from the secrets `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_PASSWORD`, `KEY_ALIAS`. Losing it means installed apps can never be updated.
- The app fits its stage inside the `--safe-area-inset-*` variables Capacitor injects on Android (`.safe` in `src/ui/styles.css`).

## Commands

- `npm run dev` — dev server on http://localhost:5173
- `npm run build` — typecheck + production build to `dist/`
- `npm test` — run all tests
- `npm run typecheck` — TypeScript check
- `npx cap sync android` — copy `dist/` into the Android project (CI does this)
- `powershell -File tools/render-icons.ps1` — re-render app icons and splash screens
