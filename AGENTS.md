# AGENTS.md

**Tag Team Ludo**: an HTML5 Ludo game for web and Android (APK via Capacitor) from one codebase. Two offline modes: vs Computer (one human against 1-3 bots) and With friends (2-4 people passing one device). In 2-player games a person can have two houses. Online play and private rooms come in a later update.

## Stack

- TypeScript, tested with Vitest, built with Vite.
- Renderer: SVG/DOM, ported from the approved mockup in `mockups/index.html` (SVG board, CSS 3D dice). No canvas, no images: all art is vector code.
- Fonts are self-hosted via `@fontsource` (Lilita One, Nunito) so the app works offline.
- Capacitor 8 wraps the same build into the Android app (`android/`, app ID `com.jutebags.ludo`, portrait only, minSdk 24 = Android 7.0).
- GitHub Actions (`.github/workflows/build.yml`) builds and ships everything; see "Build and release" below.
- No game framework: Phaser/PixiJS were considered and dropped because they would mean rebuilding the mockup art as textures.

## Layout

- `docs/RULES.md` — the source of truth for every game rule, including the pair (jodi) rule. Change it together with the engine. The dice are specified only in `src/engine/dice.ts`: keep how rolls are made out of every `.md` file and the website.
- `src/engine/` — pure rules engine, no DOM:
  - `board.ts` constants and progress → square mapping
  - `rules.ts` legal moves, pairs/blocks, captures, threats
  - `dice.ts` the dice: the full spec lives in its header comment
  - `game.ts` turn flow (`createGame` from seats, `newGame` for the classic game, `roll`, `move`, `finalRanking`, `ownerRanking` for people)
  - `bot.ts` single-level heuristic bot (`chooseMove`, `botStep`)
  - `rng.ts` seeded RNG for tests, `cryptoRng` for real play
- `src/ui/` — the game UI (DOM + SVG), driven by the engine:
  - `app.ts` fixed 390 x 844 stage scaled to fit any screen, routing home → setup → game
  - `art.ts` all vector art (board and the palace in its centre, pawns, avatars, trophy) and the shared SVG `<defs>`
  - `palace.ts` the palace cutscene: when a person's token gets home, a short scene in that colour's kingdom (Red: the Ember Keep, Green: the Emerald Grove, Yellow: the Sun Citadel, Blue: the Tide Palace) welcomes it through the gate, cheered on by stick figures; tap to skip, still under reduced motion. Bots' tokens get the HOME! banner only
  - `geometry.ts` board cell coordinates and the four track turns; track order must match `src/engine/board.ts`
  - `targets.ts` pure: one landing marker per legal move, nearest-tap picking, why a token can't move (tested)
  - `boardView.ts` pawn placement, stacking, double badges (padlock = locked, ×2 = on a star, ! = single on an enemy double), landing markers, board-wide tap picking, hop/kill/finish effects
  - `sfx.ts` sounds synthesised with Web Audio (no audio files) and vibration; mute is in the pause menu
  - `dice.ts` CSS 3D die and roll animation
  - `gameScreen.ts` turn loop, bot pacing, human move choice (via landing markers), banners, pause menu, result screen
  - `homeScreen.ts` home screen: VS COMPUTER and WITH FRIENDS (both offline), player count; Online/Private tiles are locked placeholders
  - `setup.ts` pure and tested: `GameConfig`, ranking rolls, the house-picking rules (opposite / side by side)
  - `setupScreen.ts` one step per screen (no scrolling): options (houses each, bots for empty houses), roll for order (ties roll again), pick houses one by one; steps with nothing to choose are skipped
  - `avatars.ts` generated Fun Emoji avatars (CC BY 4.0, credited on the home screen); regenerate with `node tools/make-avatars.mjs`
- `tests/` — Vitest specs: rules, turn flow, dice (incl. Monte Carlo), bot simulations, teams (`teams.test.ts`), setup rules (`setup.test.ts`), UI logic (`targets.test.ts`), and rule invariants checked on every move of hundreds of random, bot and two-house games (`invariants.test.ts`). `tests/sim/` holds the long all-bot simulations (`npm run sim`): a shared `harness.ts`, and one `*.sim.ts` file per kind of game (`single-house.sim.ts`, `double-house.sim.ts`), each listing its setups.
- `mockups/` — static UI mockup and its PNG screenshots.
- `docs/` — the public website (GitHub Pages): `index.html` plus `assets/`. `docs/RULES.md` lives here too but CI leaves it out of the site.
- `android/` — Capacitor Android project. Signing and version come from CI (`android/app/build.gradle`).
- `assets/` — app icon sources (`icon-background.svg`, `icon-foreground.svg`); `tools/render-icons.ps1` renders them into `android/.../res` with headless Edge.

## Engine conventions

- State is immutable: every function returns a new `GameState`/`PlayerState[]`.
- A token is a single number, its **progress**: `-1` base, `0-50` track, `51-55` home column, `56` finished. `squareOf(color, progress)` gives the shared track square.
- Each `PlayerState` is one colour with an `owner` (the person). Colours with the same owner are one side: "enemy" always means another owner (`sameSide`), never just another colour.
- Randomness is always injected (`Rng`), so tests and replays are deterministic.
- The dice treat every player the same, bots included.

## UI conventions

- The UI never decides rules: it calls `roll`/`move` and animates the resulting state.
- A game ends for the human as soon as they finish all tokens (or are the last one left); others are ranked by `finalRanking`.
- Animations use rAF with a `setTimeout` fallback, so a stalled WebView can never hang a turn. Effects animate only `transform`/`opacity` and are skipped under `prefers-reduced-motion`.
- Taps go to the nearest movable pawn or landing marker within `HIT` board units (about 40px on a phone), never to a precise hit area.
- Dev only: `window.__ludo` is the running `GameScreen` (`forced` dice queue, `speed` multiplier) for testing.

## Build and release

Repo: https://github.com/JuteBags/Tag-Team-Ludo · site: https://jutebags.github.io/Tag-Team-Ludo/

- CI tests and builds every push to `main` and every PR (run artifacts only). It **deploys on a pushed `v*` tag, or when run by hand on `main`**: `gh workflow run build.yml --ref main -f release_notes="..."` (text or a committed `.md` path), optionally `-f commit=<sha>` to build and deploy any exact commit. Tags and hand runs reject empty or placeholder notes. Every PR also runs `sim.yml`: all-bot games on `main` and the PR with the same seeds, compared in one PR comment that updates on each push.
- A deploy → tests, web build, signed APK, then the Pages site is assembled from `docs/` + the game at `/play/` + the APK at `/download/tag-team-ludo.apk` (with `download/version.json`). The `github-pages` environment allows deploys from `main` and from `v*` tags.
- Releasing: bump `version` in `package.json` and add `release-notes/<version>.md`, merge, then push tag `v<version>` on the merged commit (it must match `package.json`). The run publishes the GitHub Release with the signed APK, AAB and Windows `.exe`. A hand run on `main` whose version has no tag yet does the same and creates the tag.
- Windows: `desktop/` is an Electron shell (`main.js`, own `package.json` and lock file) that opens the web build in a 460 × 920 window. The `windows` job (on `windows-latest`) copies `dist/` into `desktop/web/` and builds a portable x64 `.exe` with electron-builder. It runs for releases and hand runs only. `npm start` in `desktop/` runs it locally after copying `dist/` to `desktop/web/` (Node 24's npm skips Electron's binary download; run `node node_modules/electron/install.js` once).
- `versionCode` = workflow run number; never rename `build.yml` or it restarts at 1.
- Release key: `~/ludo-signing/` (`ludo-release.jks`, `keystore.properties`), alias `ludo`, SHA-256 `7A:B3:6E:10:…:1A:A4`. It is PKCS12, so the key password is the same as the store password. CI reads it from the secrets `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_PASSWORD`, `KEY_ALIAS`. Losing it means installed apps can never be updated.
- Local release-signed builds (to test updates on MuMu or a phone with the same key as CI): with the key in `~/ludo-signing/`, run `gradlew assembleRelease` with `KEYSTORE_PROPERTIES=~/ludo-signing/keystore.properties` (read by `android/app/build.gradle`). GitHub secrets can't be read back, so the key file has to come from whoever holds it. A device with a debug-signed install needs one uninstall before the first release-signed one.
- The app fits its stage inside the `--safe-area-inset-*` variables Capacitor injects on Android (`.safe` in `src/ui/styles.css`).

## Commands

- `npm run dev` — dev server on http://localhost:5173
- `npm run build` — typecheck + production build to `dist/`
- `npm test` — run all tests
- `npm run sim` — all the long all-bot simulations (`tests/sim/*.sim.ts`; `SIM_GAMES=500` for a quick pass, or name one file: `npm run sim -- tests/sim/single-house.sim.ts`). CI runs every file as its own job, in parallel, on every PR (`.github/workflows/sim.yml`), compares each with `main` via `tools/sim-compare.mjs`, and joins them into one PR comment. A new kind of game gets a new `*.sim.ts` file; CI picks it up by itself.
- `npm run typecheck` — TypeScript check
- `npx cap sync android` — copy `dist/` into the Android project (CI does this)
- `powershell -File tools/render-icons.ps1` — re-render app icons and splash screens

## Commits and pull requests

Commit messages and PR titles start with a [Conventional Commits](https://www.conventionalcommits.org/) type: `feat:` (a new feature for players), `fix:` (a bug fix), `ci:` (workflows, builds, releases), `test:` (tests and simulations), `docs:`, `refactor:`, `perf:`, `chore:`. Add a scope when it helps (`feat(setup): ...`) and `!` for a breaking change. PRs say which issue they close (`Closes #5`).
