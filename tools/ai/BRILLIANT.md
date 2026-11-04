# Brilliant moves (#100): the molab study

The data for choosing a Brilliant (!!) rule, measured on the owner's molab box with `tools/ai/brilliant.ts`. Each
batch runs one pinned commit; its JSON lines are committed under `data/brilliant/` straight after the batch.

## What is logged

At every real decision of the side under study (self-play with the app's engine: Extreme = race:128, the app's dice, fixed seeds):

- the best move at 16, 32, 48, 64, 96, 128 and 256 playouts, at two review seeds (`ladder.a`, `ladder.b`): n\*, the
  smallest count from which the best stays the 256-best, is scored offline;
- every candidate's gap and standard error at 256 (points of win chance), and the spread;
- the move played and the Hard bot's pick in the same position (idea 2).

Studies: `extreme` (every seat Extreme, every seat logged), `first` (seat 0 always plays its first move) and
`normal` (seat 0 the Normal bot); in the last two only seat 0 is logged.

**Every game plays to the end** (the owner's rule): both engines end a game only when one person is left
(`game.ts` move / `sim-rs game.rs` play), with no keep-playing vote and no stop at the first finisher. The
native run reports any game cut by its step cap ("unfinished": 0 so far). The review ladder's playouts still
score who wins, since first place is settled once someone finishes.

## Engines and parity

Two paths log the same fields: `tools/ai/brilliant.ts` (the app's WebAssembly engine in Node) and
`sim-rs/src/bin/ludo-brilliant.rs` (native, rayon, at most 16 threads). The native path uses sim-wasm's exact
parameters: `choose_race` 128 playouts, cut 12, the net at the cut, the playout rules in the playouts, the app's
dice; TS Hard = `net:<hard-rules>:1` (depth 1, chance 2, their_k 3), TS Normal = `greedy:<hard-rules>`; the
rules JSON is written from the app's sources by `tools/ai/rules_json.ts`. The review is the same function on
both (`rollout::review_cached`, which sim-wasm's `review` export calls), so the same position and seed give the
same values. The dice streams differ, so the games differ: parity is checked on distributions (4p, 16 games each).

| | wasm 4p (5,388 decisions) | native 4p (5,783) |
|---|---|---|
| decisions per game | 337 | 361 |
| spread p50 / p90 (points) | 2.30 / 5.81 | 2.19 / 5.64 |
| SE at 256, p50 | 0.29 | 0.29 |
| Extreme plays the 256-best | 65.7% | 66.2% |
| Hard's pick is the 256-best | 61.6% | 63.3% |
| seed B's 256-best = seed A's | 91.1% | 89.9% |
| n\* = 16 / 32 / 48 / 64 / 96 / 128 / 256 | 72.4 / 7.0 / 4.0 / 3.3 / 3.7 / 3.3 / 6.3% | 71.5 / 7.3 / 3.9 / 3.3 / 3.9 / 3.5 / 6.6% |

Native is about 2x the wasm path (16 games of 4p in 156 s vs about 315 s on 16 workers): the review ladders,
not the games, are the cost.

## Runs

| Batch | Commit | Layouts / study | Games | Decisions | Time |
|---|---|---|---|---|---|
| pilot | 52ed272 | 2p, 4p, 2h-opposite / extreme, 1 game each, 3 workers (wasm) | 3 | 125 / 359 / 364 | 45 / 195 / 195 s |
| 4p-1 | 52ed272 | 4p / extreme, seeds 1-16, 16 workers (wasm), 2 calls | 16 | 5,388 | 255 + 60 s |
| native-4p-1 | 256fa35 | 4p / extreme, seeds 1-16, 16 threads (native), parity | 16 | 5,783 | 156 s |

Box rules followed: one driver, at most 16 workers under `nice -n 10`, one blocking call of 5 min or less per batch
(with a progress line every 15 s so the stream stays open), a liveness check before each batch, nothing detached,
code only by git at a pinned commit, data off the box after every batch.
| native 4p | 256fa35 | 4p / extreme, 16 threads, old ladder 16…256 | 228 | 76,143 | about 4 min per 24 games |
| native 2h | 256fa35 | 2h-opposite / extreme, old ladder | 160 | 49,893 | 8 calls |
| native 2p | e23af75 | 2p / extreme, ladder 8,10,16,24,30,32,48,64,96,128,256 (`at` on each line) | 576 | 71,924 | 64 + 4 × 128 games, about 170 s per call |
| native 2p controls | e23af75 | 2p / first (owner 0 plays move 0), 2p / normal (owner 0 = TS Normal); the other seat Extreme | 384 / 256 | 20,352 / 15,353 | about 55 / 75 s per 128 games |

Commit e23af75 added the rungs 8, 10, 24 and 30; review_cached extends the same playouts rung to rung, so the
new rungs cost little. Files from 256fa35 have no `at` field and use the old ladder; they are scored at N ≥ 32 only.

## Scoring (all native data)

`python tools/ai/brilliant_score.py data/brilliant/native data/brilliant/score-native.json`, then
`brilliant_table.py` for the table and `brilliant_diag.py` for the diagnostics. Rule (N, M, Z): the move played is
the 256-best at seed A, seed B agrees at 256, n\* ≥ N at both seeds (n\* = the rung from which every rung's
favourite is that move, with a lower rung disagreeing), and the favourite one rung below n\* is worse at 256 by
≥ M points and ≥ Z SE. N = 8 and 10 are the same rule (the lowest rung is 8, so n\* ≥ 10 always).

Brilliant per player-game (2p unless noted):

| N | margin | Extreme | Normal | First-move | Extreme 4p | Extreme 2h |
|---|---|---|---|---|---|---|
| 8 | ≥2 pts & 2 SE | 2.05 | 1.52 | 0.92 | – | – |
| 8 | ≥3 pts & 2 SE | 1.14 | 0.85 | 0.40 | – | – |
| 16 | ≥2 pts & 2 SE | 1.52 | 1.19 | 0.72 | – | – |
| 24 | ≥1 pt & 1 SE | 2.19 | 1.97 | 1.23 | – | – |
| 30 | ≥1 pt & 1 SE | 1.43 | 1.38 | 0.79 | – | – |
| 32 | ≥1 pt & 1 SE | 1.01 | 0.98 | 0.57 | 1.05 | 1.48 |
| 32 | none | 3.76 | 3.45 | 2.40 | 4.86 | 10.53 |
| 64 | none | 2.30 | 2.07 | 1.38 | 1.85 | 4.12 |
| 96 | none | 1.57 | 1.39 | 0.91 | 1.24 | 2.75 |

(Every N × margin is in `score-native.json`; the seed halves agree within 0.06 everywhere for Extreme 2p.)

**No rule meets the target.** Normal scores 85–100% of Extreme's rate at every rule, and the first-move control
40–65%. Why: the decisions this rule picks are close calls, and every player plays the 256-best about equally
often: Extreme 62.0%, Normal 60.0%, first-move 63.1% (move 0 is the 256-best in 63% of the first-move player's own
decisions, so "first move" is not a weak player in this engine). A Brilliant flag on a single decision measures
landing on the right side of a close call, which any reasonable player does at about the same rate. Requiring
that Hard's pick also misses does not separate them either (per player-game 0.13 Extreme, 0.14 Normal, 0.18 first).
