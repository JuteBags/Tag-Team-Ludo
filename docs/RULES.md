# Tag Team Ludo — game rules (v1)

Approved 2026-10-30. The engine in `src/engine/` and the game screen implement exactly these rules; tests in `tests/` check them. This file stays off the public website because of section F (weighted dice).

## A. Setup

1. The board has a 52-square track, a 5-square home column for each colour, and the centre as the finish.
2. Each player has 4 tokens, all starting in their base.
3. Turn order goes clockwise: Blue (bottom-left, you) → Green (top-left) → Red (top-right) → Yellow (bottom-right).
4. 2 players: Blue and Red (opposite corners). 3 players: Blue, Green and Red. 4 players: all four.
5. You play Blue; every other colour is a bot.

## B. Moving

6. Tokens move clockwise round the track, then up their own home column into the centre. From the start square to the centre is 56 steps.
7. You need a **6** to bring a token out of base onto your start square. Bringing it out uses the whole roll.
8. You need the exact roll to reach the centre; a move that would go past it isn't allowed.
9. If none of your tokens can move, your turn passes.
10. Tokens in the home column always move one at a time.

## C. Extra rolls

11. Rolling a **6** gives another roll, even when nothing could move.
12. A **third 6 in a row** is cancelled and the turn passes (moves from the first two 6s stay).
13. Capturing an enemy token gives another roll.
14. Getting a token into the centre gives another roll.

## D. Capturing and safe stars

15. Landing on a single enemy token on a normal square captures it: it goes back to its base.
16. There are 8 safe stars: each colour's start square and the square 8 steps after it.
17. Nobody can be captured on a star; tokens of any colour can share it.

## E. Pairs (jodi)

18. Two of your tokens on the same track square are a **pair**. This includes two tokens brought out onto your start square.
19. On an even roll a pair can move together, each token moving half the roll: 2 → 1 + 1, 4 → 2 + 2, 6 → 3 + 3 (plus the extra roll for the 6).
20. On an odd roll a pair can't move as a pair.
21. Moving as a pair is optional: you can always move one token alone, which breaks the pair.
22. A pair on a normal (non-star) square is a **block**.
23. No enemy token, single or pair, can land on a block or pass it.
24. Your own tokens can pass your own block.
25. A pair on a star doesn't block: enemies can land on it or pass it, and nobody is captured there.
26. A pair can never be captured: on a normal square it is a block, and on a star it is safe.
27. A pair that lands on a single enemy token on a normal square captures it.
28. A block has no time limit.
29. Three or more of your tokens on one square also block; a pair move takes two of them.
30. There are no pairs in the home column.

## F. Weighted dice (everyone, bots included)

31. Before each roll, every face starts at **3/18** (16.7%).
32. A face that would capture an enemy token (**kill**) goes up to **4/18** (22.2%).
33. A face that would take a threatened token to a star or into the home column (**escape**) goes up to **4/18**. A token is threatened when an enemy could capture it with a single roll of 1–6.
34. At most **2 faces** are boosted per roll: kills first, then escapes; ties are picked at random.
35. A face that would finish a token exactly goes down to **2/18** (11.1%).
36. A face that is both boosted and lowered stays at 3/18.
37. Bringing a token out of base is not a reason to boost the 6.
38. The untouched faces share the difference equally, so the six faces always add up to 1.
39. No face goes below **2/18** or above **5/18**.

## G. Winning and ranking

40. A player is done when all 4 of their tokens reach the centre.
41. The finishing order is the ranking.
42. The game ends as soon as you finish all 4 tokens, or when only one player is left. Anyone still playing is ranked by how far their tokens have travelled.

## Known risks (accepted for v1, revisit after playtests)

- Bots get the kill boost too, so they hit you a little more often.
- A block parked on a normal square can hold an opponent back for a long time.
- The weighting is hidden. The repo is public, so anyone who reads the code can find it; we never advertise "fair dice".
