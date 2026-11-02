# Game review calibration (#65, #96)

This is how the game review's numbers were set: the accuracy formula, the label cuts per layout, and the playouts per decision. They were agreed between ludo-ce (dev) and ludo-ed (PM) on bot games reviewed on GitHub Actions, not on a laptop. The code is in `src/engine/ai/review.ts`; the tool is `tools/ai/review_calib.ts`, and the workflow is `.github/workflows/review-calibration.yml`.

## Data

Each run reviews one seat's moves in bot games, with the app's own WebAssembly engine and every other seat Hard. There is one job per layout and mover, with at least 600 reviewed decisions and 30 games each, on fixed seeds.

- **Movers:**
  - Hard;
  - Normal;
  - "first": always plays the first legal move.
- **Run 2** (Actions run 41361060518): label rates and gap quantiles, with spread filters.
- **Run 4** (Actions run 41368471118): the same games, plus every decision dumped to the artifact `calib-<layout>-<mover>/decisions.jsonl`. Each line holds the gap, SE, spread, the label at 256 playouts and the label at 128.

A decision's **spread** is its best move minus its worst, in points of win chance (0-100). A decision is **meaningful** when its spread is at least 3 (`MEANINGFUL`).

## Why bot-vs-bot can't be the yardstick for separating levels

The rollouts' playout policy is the same weighted rules that Normal and Hard play. So moves that agree with those rules look "best" to the engine, and a rules bot scores near-perfect by construction. Even on spread ≥5 decisions, Hard and Normal differ by only 1.6–3.9 points of label accuracy (run 2).

The original target of ≥8 points between Hard and Normal was dropped for this reason. The real yardstick is human games: an opt-in check on the owner's games after 2.5.0.

## Accuracy

`accuracy = 1 − Σgap / Σspread` over a player's meaningful decisions (`accuracyOf`). Of everything at stake in the game, it is the share the player kept, so big decisions weigh more. A move labelled Best counts as 0: its gap is within noise, and the number should agree with the label. The card also shows "N key mistakes" (mistakes plus blunders).

Run 4, accuracy %, by mover (per-game SD in brackets):

| layout | Hard | Normal | first |
|---|---|---|---|
| 2p | 96.1 (3.4) | 93.7 (8.1) | 80.0 |
| 3p | 97.7 (2.0) | 92.6 (8.6) | 79.2 |
| 4p | 97.9 (2.4) | 92.5 (8.8) | 71.8 |
| 2h-opposite | pending | pending | 80.2 |

**Acceptance (ludo-ed):**
- Hard > Normal > first in every layout: **holds**.
- Hard's per-game SD < 6: **holds** (2.0–3.4).
- First-move ≤ ~75: **met in 4p only** (2p, 3p and 2h are at 79–80). This was accepted: the first legal move is often reasonable in Ludo, and the 75 target was arbitrary.

**Rejected variants:**
- Also subtracting 1.5 from the other gaps squeezes the levels: first-move goes to 80–86.
- A stakes prior, `1 − Σgap / (Σspread + K)`, lifts the weakest player most: 4p first-move goes 70 → 81 at K = 20.

**MEANINGFUL 3 or 5:** we kept 3. At 5, the meaningful decisions per game drop below the ~15 guard at p10 in every layout, and Hard's SD in 4p rises to 5.3. Meaningful decisions per game, p10:

| | 2p H / N / F | 3p H / N / F | 4p H / N / F | 2h F |
|---|---|---|---|---|
| ≥3 | 19 / 14 / 5 | 19 / 18 / 7 | 15 / 11 / 6 | 17 |
| ≥5 | 13 / 7 / 2 | 6 / 6 / 2 | 4 / 5 / 0 | 5 |

## Label cuts

The 2p cuts in points given up:

| Label | Points given up |
|---|---|
| Best | ≤ 1.5, or within one standard error of the top |
| Good | < 2 |
| Inaccuracy | < 5 |
| Mistake | < 10 |
| Blunder | ≥ 10 |

Each layout scales every cut by its factor `f` (`THRESHOLDS_BY_LAYOUT`), and no cut goes under 1 point. With more players a move's gaps are smaller, so the same cut would be harsher there.

`f` is the p95 of Normal's meaningful-decision gaps in that layout over the p95 in 2p. Normal's p75 gap is 0 in every layout (over 75% of its meaningful decisions are Best), so p75 can't give a ratio. Its p90 and p95 disagree by up to 62% in 4p: more players compress the small gaps (more near-ties), not the tail. The mistake and blunder cuts sit in the tail, so p95 alone is the quantile that matches where they live.

The factors come with 1000-fold bootstrap intervals, resampled by game:

| layout | p95 ratio | 90% interval | f used |
|---|---|---|---|
| 2p | 1 | (base) | 1 |
| 3p | 0.84 | 0.61 – 1.27 | **0.85, provisional** |
| 4p | 0.86 | 0.46 – 1.17 | **0.85, provisional** |
| 2h-opposite | pending (run 2: 0.68) | pending | **0.7, provisional** |
| 2h-side | not calibrated | | 2h-opposite's |

The tail behind each p95 is only about 45–52 points, so the intervals are wide (±0.35) and every factor is rounded to 0.05 and marked provisional. Both intervals include 1.0. Doubles-off games use their layout's row. The next calibration, on human games, should narrow these.

## Playouts per decision

Reviewing every decision from 128 playouts instead of 256 (with the same top-ups near a label's edge, up to 1024) gives the same label on 99.8–100% of decisions, and on 95.9–100% of those that either side calls a key move (run 4). The review uses 128 (#101).

## Changing these

Change these values only from a new calibration run. Bump `REVIEW_VERSION` with them: reviews stored under another version are redone, and the old one shows greyed until the new one is in.
