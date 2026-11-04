# How the #142 review frames were made (seed 24, Blue the person)

1. **The game.** A 2p game played by two Hard bots with the app's dice, seed 24, then recorded with Blue as the person: seats `[{ color: 'blue', owner: 0, bot: false }, { color: 'red', owner: 1, bot: true, level: 'hard' }]`, `first: 'blue'`, `seed: 24`.
   - The play loop is review_speed.ts's game with `rng = seeded(24)`: `seededDie(24, s)` for each roll, and `chooseBotMove(s, rng)` with every seat at Hard.
   - `encodeRecord(rec)` gives the share payload, which is `game-seed24.link.txt`.
   - The game has a cancelled run of three 6s at move 139, worth -6% to win for Blue.
2. **The app.** A production build served by `npx vite preview` (or the dev server), opened at `<url>/#game=<payload>`. It opens straight into the replay.
3. **The frames.** `node frames142.mjs <url> <outDir> game-seed24.link.txt`, with playwright-core and headless Chromium (the copy in S:/tools/lemo-opuscar/node_modules). It:
   - uses a 360x780 viewport at DPR 2;
   - taps **Review** and waits until the three-6s row is listed (the review runs in the worker);
   - saves `142-list.png`, the row, and the replay after tapping the row (`142-replay.png`).
