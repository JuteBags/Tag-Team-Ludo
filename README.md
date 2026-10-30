# Tag Team Ludo

[![Build and deploy](https://github.com/JuteBags/Tag-Team-Ludo/actions/workflows/build.yml/badge.svg)](https://github.com/JuteBags/Tag-Team-Ludo/actions/workflows/build.yml)

**Tag Team Ludo** is classic Ludo against computer players, plus the **pair move** (jodi): two of your tokens on one square move together and block the way. One HTML5 codebase runs in the browser and ships as an Android app.

- **Website:** https://jutebags.github.io/Tag-Team-Ludo/
- **Play in the browser:** https://jutebags.github.io/Tag-Team-Ludo/play/
- **Download the APK:** https://jutebags.github.io/Tag-Team-Ludo/download/tag-team-ludo.apk (Android 7.0 or newer)
- **Versioned releases:** https://github.com/JuteBags/Tag-Team-Ludo/releases

![Design mockups: home screen, a game in progress and the winner screen](docs/assets/design-showcase.png)

## What's in v0.1

- 2, 3 or 4 player games: you against 1-3 bots, fully offline.
- Classic rules: a 6 brings a token out and rolls again, captures send tokens home, stars are safe, exact roll to finish.
- The pair move: on an even roll a pair moves half the roll each (4 → 2 + 2). Single tokens can't jump an enemy pair (they can stop on it), and only a pair can cut a pair.
- Glossy 2.5D look drawn in vector code (SVG + CSS 3D dice), so it stays sharp on any screen and the app stays small.

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

[`.github/workflows/build.yml`](.github/workflows/build.yml) runs only when started by hand (Actions → Build and deploy → Run workflow), and only with **release notes**: what changed, for players. Pushes and pull requests don't trigger it. A run with empty or placeholder notes ("test", "fix") fails before anything is built. The notes go into the GitHub Release, `download/version.json` and the run summary. What it does depends on the branch or tag it runs on:

| Run on | Result |
|---|---|
| `main` | Tests, web build, signed APK, website deployed to GitHub Pages with the game at `/play/` and the APK at `/download/tag-team-ludo.apk` |
| A tag `v1.2.3` | Signed APK + AAB attached to a GitHub Release (`v1.2.3-rc1` style tags become pre-releases) |
| Any other branch | Tests, web build and APK as a run artifact |

To publish a version:

```bash
git tag v0.1.0
git push origin v0.1.0
gh workflow run build.yml --ref v0.1.0 -f release_notes="Pairs now lock on normal squares; only a pair can cut a pair."
```

For longer notes, commit a Markdown file and pass its path: `-f release_notes=release-notes/0.1.0.md`.

Run the tests locally before pushing: `npm test`, plus `npm run sim` for the long all-bot simulation.

The APK is signed with the release key stored in the repository secrets `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_PASSWORD` and `KEY_ALIAS`. Without them CI builds a debug APK instead.
