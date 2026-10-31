# Tag Team Ludo

[![Build and deploy](https://github.com/JuteBags/Tag-Team-Ludo/actions/workflows/build.yml/badge.svg)](https://github.com/JuteBags/Tag-Team-Ludo/actions/workflows/build.yml)

**Tag Team Ludo** is classic Ludo against computer players, plus the **pair move** (jodi): two of your tokens on one square move together and block the way. One HTML5 codebase runs in the browser and ships as an Android app.

- **Website:** https://jutebags.github.io/Tag-Team-Ludo/
- **Play in the browser:** https://jutebags.github.io/Tag-Team-Ludo/play/
- **Download the APK:** https://jutebags.github.io/Tag-Team-Ludo/download/tag-team-ludo.apk (Android 7.0 or newer)
- **Versioned releases:** https://github.com/JuteBags/Tag-Team-Ludo/releases

![Design mockups: home screen, a game in progress and the winner screen](docs/assets/design-showcase.png)

## What's in the game

- Two offline modes: **vs Computer** (you against 1-3 bots) and **With friends** (2-4 people passing one phone).
- Roll for order before every game, then pick your house; in 2-player games each person can take two houses, opposite or side by side.
- Classic rules: a 6 brings a token out and rolls again, captures send tokens home, stars are safe, exact roll to finish.
- Roll your whole turn first: every 6 rolls again and the dice wait in a tray, then you play them in any order on any token. A kill rolls again right away.
- The pair move: on an even roll a pair moves half the roll each (4 → 2 + 2). Single tokens can't jump an enemy pair (they can stop on it), and only a pair can cut a pair.
- Prefer classic Ludo? Turn **Doubles** off in Settings and every token moves alone, with nothing blocking.
- A board that shows the way: arrows at every turn, and after each roll a marker where every possible move lands.
- Rolls and kills with feel: a cup throw with a camera push-in, kill impacts, banners, sounds and vibration.
- Glossy 2.5D look drawn in vector code (SVG + CSS 3D dice), so it stays sharp on any screen and the app stays small.
- The palace: the centre of the board is a castle, and each colour's tokens are welcomed home with their own short cutscene.
- Bots at three levels: Easy, Normal and Hard (picked in setup; the last choice is remembered).
- Keep playing or stop: when someone finishes, the players still in vote on whether to play on for the next place.
- Continue an unfinished game, even after the app was closed. The screen stays awake during a game, and the back button pauses.
- Share your result as an image, see your stats, pick a board (Classic, Wooden, Dark), and turn on colour-blind symbols (● ▲ ■ ◆) from the home screen.

Online play and private rooms are planned for a later update.

## Development

Needs Node 24.

```bash
npm install
npm run dev        # game at http://localhost:5173
npm test           # rules, dice and bot simulation tests
npm run sim        # 18,000 all-bot games: kills, idle rolls, game length (minutes)
npm run build      # typecheck + production build to dist/
```

To open the Android project in Android Studio: `npm run build`, then `npx cap sync android`, then open `android/`.

## Project layout

| Path | What it is |
|---|---|
| `src/engine/` | Pure rules engine: moves, pairs and blocks, dice, turn flow, bot |
| `src/ui/` | Game UI (DOM + SVG) driven by the engine |
| `tests/` | Vitest specs |
| `android/` | Capacitor Android project (`com.jutebags.ludo`) |
| `docs/` | The website, published to GitHub Pages; `docs/RULES.md` is the full rules spec |
| `assets/`, `tools/` | App icon sources and the script that renders them |
| `mockups/` | Original UI mockups |

See [AGENTS.md](AGENTS.md) for architecture notes and conventions.

## Build and release

[`.github/workflows/build.yml`](.github/workflows/build.yml) tests and builds every push to `main` and every pull request, and **deploys on a version tag or when someone runs it by hand**:

| Trigger | Result |
|---|---|
| Push to `main`, pull request | Tests, web build and a signed APK as run artifacts. **Nothing is deployed.** PRs also get the simulation comparison comment ([`sim.yml`](.github/workflows/sim.yml)) |
| Push a tag `v1.2.3` | The same, then deploys the website with the game at `/play/` and the APK at `/download/tag-team-ludo.apk`, and publishes GitHub Release `v1.2.3` with the signed APK, AAB and Windows `.exe`. The tag must match `version` in `package.json`, and `release-notes/1.2.3.md` must exist |
| Run by hand on `main` | Deploys the latest `main`, or any exact commit given as `commit`. If `package.json` has a version with no `v<version>` tag yet and `release-notes/<version>.md` exists, it also publishes GitHub Release `v<version>`, tagged on the commit it built |
| Run by hand on another branch | Build only (including the Windows `.exe`), nothing deployed |

To release a new version: bump `version` in `package.json` and add `release-notes/<version>.md` in a PR, merge it, then tag the merged commit:

```bash
git tag v1.0.1 origin/main
git push origin v1.0.1
```

Or run it from Actions → Build and deploy → Run workflow (Use workflow from: `main`):

```bash
# Deploy the latest main (and release it if its version is new and has notes)
gh workflow run build.yml --ref main -f release_notes=release-notes/1.0.1.md
# Build and deploy one exact commit
gh workflow run build.yml --ref main -f commit=<sha> -f release_notes="What changed, for players"
```

Tags and hand runs need real release notes (text, or the path of a committed `.md` file): empty or placeholder notes ("test", "fix") fail the run before anything is built. A release always uses its `release-notes/<version>.md`.

The Windows `.exe` is a portable Electron build of the web game ([`desktop/`](desktop/)), about 96 MB, so it's attached to GitHub Releases rather than hosted on the website.

Every pull request also plays all-bot games (with doubles on and off, one and two houses each, and the bot levels) on `main` and on the PR with the same seeds, and comments with the difference: kills, idle rolls, game length, pair moves, and one player's view (win rate, kills, tokens lost, time stuck at home). A PR that doesn't change the game shows "No change".

Run the tests locally before pushing: `npm test`, plus `npm run sim` for the long all-bot simulation.

The APK is signed with the release key stored in the repository secrets `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_PASSWORD` and `KEY_ALIAS`. Without them CI builds a debug APK instead.

## Credits

- Avatars: [Fun Emoji](https://www.figma.com/community/file/968125295144990435) by Davis Uche, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), generated with [DiceBear](https://www.dicebear.com) (`tools/make-avatars.mjs`).
