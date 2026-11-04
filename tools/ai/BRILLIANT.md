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

## Runs

| Batch | Commit | Layouts / study | Games | Decisions | Time |
|---|---|---|---|---|---|
| pilot | 52ed272 | 2p, 4p, 2h-opposite / extreme, 1 game each, 3 workers | 3 | 125 / 359 / 364 | 45 / 195 / 195 s |

Box rules followed: one driver, at most 16 workers under `nice -n 10`, one blocking call of 5 min or less per batch
(with a progress line every 15 s so the stream stays open), a liveness check before each batch, nothing detached,
code only by git at a pinned commit, data off the box after every batch.
