# Game rules (v1)

Approved 2026-10-30. The engine in `src/engine/` implements exactly this; tests in `tests/` check it.

## Board and seats

- 52-square track, 5-square home column per colour, centre = finished.
- Seats (clockwise turn order): Blue (bottom-left, you) → Green (top-left) → Red (top-right) → Yellow (bottom-right).
- 2 players: Blue + Red (opposite corners). 3 players: Blue, Green, Red. 4 players: all.
- A token's position is its **progress**: `-1` base, `0` its start square, `0–50` track, `51–55` home column, `56` finished. Start to finish is 56 steps.
- Safe stars: each colour's start square and the square 8 steps after it (8 squares total).

## Classic rules (same as Ludo King)

- A **6** releases a token from base onto its start square. That uses the whole roll.
- Rolling a **6** gives another roll, even when no move is possible.
- A **third 6 in a row** cancels that roll and the turn passes.
- **Capture:** landing on a single enemy token on a non-star square sends it back to base and gives another roll.
- On a **star**, tokens of any colour share the square and nobody is captured.
- **Finishing** needs the exact roll; overshooting the centre is not allowed. Finishing a token gives another roll.
- No legal move (and no 6) → the turn passes.
- A player is done when all 4 tokens finish. Finishing order is the ranking; players still playing when the game ends are ranked by total progress.

## Pair (double / jodi)

- Two tokens of the same colour on the same track square are a **pair**. This includes two tokens just released onto the start square.
- **Pair move:** on an even roll, the pair can move together, half the roll each (4 → 2 + 2, 6 → 3 + 3 plus the usual extra roll). On an odd roll, the pair can't move as a pair.
- Moving as a pair is optional: you can always move one token alone, which breaks the pair.
- **Block:** a pair on a **non-star** square blocks. No enemy token or enemy pair can land on it or pass it. Your own tokens can.
- **No block on stars:** on a star, a pair is just two safe tokens. Enemies can land on and pass it. The two tokens can still do a pair move.
- A block has no time limit.
- A pair landing on a single enemy token on a non-star square captures it.
- Inside the home column there are no pairs: tokens there always move one at a time.
- Three or more tokens on one square also block; a pair move takes two of them.

## Weighted dice (everyone, bots included)

Weights are in eighteenths. Each face starts at **3/18** (16.7%). Before each roll, the engine checks every face from the roller's legal moves:

| Situation for face *f* | Weight |
|---|---|
| A move with *f* captures an enemy token (**kill**) | 4/18 (22.2%) |
| A move with *f* takes a **threatened** token to a star or into the home column (**escape**) | 4/18 |
| A move with *f* finishes a token exactly (**finish**) | 2/18 (11.1%) |
| Both boosted and lowered | 3/18 (cancels out) |
| A 6 that would release a token | no boost (stays 3/18) |

- **Threatened** = an enemy token could capture it with a single roll of 1–6.
- At most **2 faces** are boosted per roll: kills first, then escapes. Ties are broken at random.
- The other (untouched) faces share the difference equally, so the six faces always add up to 1.
- No face goes below **2/18** or above **5/18**.

### Known risks (accepted for v1, revisit after playtests)

- Bots get the kill boost too, so they hit you a little more often.
- A block parked on a normal square can hold an opponent back for a long time.
- The weighting is hidden. In the web build anyone who reads the code can find it, so we never advertise "fair dice".
