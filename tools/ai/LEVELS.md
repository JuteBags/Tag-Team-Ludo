# Bot levels

What each level plays (`src/engine/ai/levels.ts`), and how much stronger each one is than the level below, in every game mode.

| Level | Plays |
|---|---|
| Easy | The original Hard rule bot (`src/engine/bot.ts`, level `hard`). |
| Normal | Hard's weighted rules (`hard-rules.ts`), judging each move alone. It doesn't plan the rest of the dice in the tray, or the bonus roll a kill or a finish earns. |
| Hard | The same rules (Hard v3), planning the whole turn: every order of the tray's dice and the chance of a bonus roll (`search.ts`, depth 1). Hard v3 was fitted to paired-rollout data, then tuned by evolution (CMA-ES) in 4-player games. |
| Extreme | The rollout player, running as WebAssembly in a Web Worker (`rollout.ts`, `rollout-worker.ts`). See below. |

How Extreme picks a move:

- It plays every candidate move out up to 128 times on shared dice.
- In the playouts, Hard v2's rules (`playout-rules.ts`) play every seat for 12 turns. Then the trained value net (`extreme-net.json`) scores the position.
- Clear decisions stop after a few rounds of playouts.
- It leaves Hard's own move only for a significant gain.
- It takes about 0.2 s per move in a laptop browser.

The source is `sim-rs/src/rollout.rs` (`choose_race`), with the WebAssembly wrapper in `sim-wasm/`.

## How it was measured

Each row is one tested person playing against people who are all one level below it.

- **Even** is the share that equal players would win: 1 / people.
- **Cells** give the win rate in % with its 95% interval.
- **Seeds** are the same for every row.
  - Easy, Normal and Hard rows use 2000 seeds, with every seat in turn, so 4,000–8,000 games per row.
  - Extreme rows use 200–400 seeds, so 600–800 games per row.
- **Engine:** the Rust port (`sim-rs`). It plays the same games as the app's TypeScript engine: the TS and Rust arenas give identical results.
- **Dice:** fair dice are the baseline. The app's own dice change these numbers by about 2 points at most.

CI (`.github/workflows/ai-levels.yml`, "Bot levels") replays the Easy, Normal and Hard rows on fair dice on every pull request that touches the engine. It fails if a level no longer clears an even share against the level below. Running it by hand adds the app's dice and Extreme.

### Fair dice (the baseline)

| Mode | Even | Easy vs Random | Normal vs Easy | Hard vs Normal | Extreme vs Hard |
|---|---|---|---|---|---|
| 2 players | 50.0 | 79.2 ± 1.3 | 68.8 ± 1.4 | 54.2 ± 1.5 | 58.6 ± 3.4 |
| 3 players | 33.3 | 71.1 ± 1.1 | 44.1 ± 1.3 | 38.5 ± 1.2 | 36.5 ± 3.9 |
| 4 players | 25.0 | 64.1 ± 1.1 | 32.8 ± 1.0 | 30.8 ± 1.0 | 30.2 ± 3.2 |
| 2 players, 2 houses each (opposite) | 50.0 | 88.9 ± 1.0 | 71.4 ± 1.4 | 54.9 ± 1.5 | 59.9 ± 3.4 |
| 2 players, 2 houses each (side by side) | 50.0 | 89.1 ± 1.0 | 69.7 ± 1.4 | 53.4 ± 1.5 | 61.6 ± 3.4 |
| 2 players, no doubles | 50.0 | 90.8 ± 0.9 | 64.2 ± 1.5 | 55.5 ± 1.5 | 53.5 ± 3.5 |
| 3 players, no doubles | 33.3 | 82.1 ± 1.0 | 44.5 ± 1.3 | 39.6 ± 1.2 | 36.0 ± 3.8 |
| 4 players, no doubles | 25.0 | 76.1 ± 0.9 | 36.0 ± 1.1 | 32.9 ± 1.0 | 25.9 ± 3.0 |
| 2 players, 2 houses each (opposite), no doubles | 50.0 | 96.6 ± 0.6 | 66.6 ± 1.5 | 53.2 ± 1.5 | 61.6 ± 3.4 |
| 2 players, 2 houses each (side by side), no doubles | 50.0 | 96.4 ± 0.6 | 68.2 ± 1.4 | 53.6 ± 1.5 | 58.8 ± 3.4 |

### The app's dice

| Mode | Even | Easy vs Random | Normal vs Easy | Hard vs Normal | Extreme vs Hard |
|---|---|---|---|---|---|
| 2 players | 50.0 | 79.8 ± 1.2 | 68.2 ± 1.4 | 55.6 ± 1.5 | 56.9 ± 3.4 |
| 3 players | 33.3 | 71.6 ± 1.1 | 45.2 ± 1.3 | 38.8 ± 1.2 | pending |
| 4 players | 25.0 | 67.1 ± 1.0 | 32.8 ± 1.0 | 30.5 ± 1.0 | pending |
| 2 players, 2 houses each (opposite) | 50.0 | 89.6 ± 0.9 | 69.5 ± 1.4 | 52.3 ± 1.5 | pending |
| 2 players, 2 houses each (side by side) | 50.0 | 89.7 ± 0.9 | 69.5 ± 1.4 | 53.2 ± 1.5 | pending |
| 2 players, no doubles | 50.0 | 91.4 ± 0.9 | 61.8 ± 1.5 | 54.5 ± 1.5 | pending |
| 3 players, no doubles | 33.3 | 84.1 ± 0.9 | 44.0 ± 1.3 | 38.7 ± 1.2 | pending |
| 4 players, no doubles | 25.0 | 77.5 ± 0.9 | 37.1 ± 1.1 | 31.1 ± 1.0 | pending |
| 2 players, 2 houses each (opposite), no doubles | 50.0 | 96.5 ± 0.6 | 66.1 ± 1.5 | 53.0 ± 1.5 | pending |
| 2 players, 2 houses each (side by side), no doubles | 50.0 | 96.9 ± 0.5 | 67.4 ± 1.5 | 54.4 ± 1.5 | pending |

### Known gaps

- **4 players, no doubles:** Extreme vs Hard is 25.9 ± 3.0 there, level with Hard. It was tuned on games with doubles. Hard v3's own gain over Hard v2 is also missing without doubles.
- **The Hard over Normal step** is the smallest, about +4 points in the 2-player modes. It's a real step everywhere, but a modest one.
