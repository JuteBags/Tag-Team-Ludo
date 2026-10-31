# Tag Team Ludo — game rules (v1)

Approved 2026-10-30; pair rules revised 2026-10-30 (issue #1). The engine in `src/engine/` and the game screen implement exactly these rules; tests in `tests/` check them. This file stays off the public website.

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
17. Nobody can be captured on a star or in a home column; tokens of any colour can share a star.

## E. Pairs (jodi)

18. Two of your tokens on the same track square are a **pair**. Your single landing on your own single makes one, on any square, and so do two tokens brought out onto your start square.
19. A pair moves only on an even roll, each token moving half the roll: 2 → 1 + 1, 4 → 2 + 2, 6 → 3 + 3 (plus the extra roll for the 6).
20. On a normal (non-star) square a pair is **locked**: neither token can move alone, so on an odd roll it can't move at all.
21. A pair splits only on a star or in the home column. On a star it is just two single tokens: on an even roll you choose to move both as a pair or one token alone (the full roll); on an odd roll only one token can move.
22. A pair that lands on a star or moves into the home column splits there. There are no pairs in the home column.
23. There are no triples: a colour's tokens on one normal square are pairs in twos plus at most one single (3 tokens = a pair + a single that can move alone; 4 tokens = two pairs).
24. **Passing.** A single token can pass single tokens and your own pairs, but not an enemy pair on a normal square. A pair can pass anything, enemy pairs included.
25. **Stopping on a pair.** A single token may land exactly on an enemy pair on a normal square. Nobody is captured. From there it can move on past that pair with any later roll; if the pair moves ahead of it again, it has to land on the pair again before it can get past.
26. A single sitting on an enemy pair is not safe: any other single that lands there captures it, including a single of the pair's own colour.
27. **Pairs capture only pairs.** A pair that lands on an enemy pair on a normal square captures both of its tokens. A single can never capture a pair.
28. A pair never captures a single: it can land on a square with enemy singles and they all stay. If a pair lands on an enemy pair with a single sitting on it, only the pair is captured.
29. On a star nobody is captured, pairs don't block, and any token can land on or pass a pair there.
30. A pair has no time limit.

## F. Dice

31. Every player, bots included, rolls the same dice. How a roll is made is defined in `src/engine/dice.ts`.

## G. Winning and ranking

32. A player is done when all 4 of their tokens reach the centre.
33. The finishing order is the ranking.
34. The game ends as soon as you finish all 4 tokens, or when only one player is left. Anyone still playing is ranked by how far their tokens have travelled.

## H. Modes, setup and two houses

35. There are two modes, and both play offline. **vs Computer:** one person against 1-3 bots. **With friends:** 2-4 people on one device, every seat a person; each rolls and moves on their own turn, then passes the device on.
36. Before a game everyone rolls once. The highest roll picks a house first and plays first. People who tie roll again among themselves until every place is decided.
37. Houses are picked one by one in that order. With friends, houses nobody plays can be given to bots (0 up to the number of empty houses, chosen before rolling); bots roll for order and pick like everyone else.
38. In a 2-player game each person has either 1 house or 2 houses, chosen before rolling. With 2 houses, a person's two houses are either opposite each other or side by side, also chosen before rolling. A second pick has to match the first, and no pick may leave someone without a matching house.
39. A person's two houses are one side. They never capture each other and never block each other. Each colour still takes its own turn in clockwise order, and a pair is always two tokens of one colour.
40. A person is done when all their tokens (4, or 8 with two houses) are home. With friends, play continues for the other places until only one person still has tokens out, and that person comes last. vs Computer, the game ends for you once all your tokens are home.
41. Each time someone is done and the game isn't over yet, the people still playing vote on whether to keep playing for the next place. Everyone still playing has to agree: one "stop" ends the game there, and everyone not yet done is ranked by how far their tokens have got. Bots always vote to play on. vs Computer, the one voter is you, and you're asked when a bot finishes before you. With friends, once every person is done, the game ends without waiting for the bots.

## I. Doubles off (classic Ludo)

42. Doubles are on by default. **Settings → Doubles → Off** (on the home screen) plays every new game without them; section E doesn't apply. The choice is saved with each game, so a continued game or Play again keeps its rules.
43. Every token moves alone, with the full roll. There are no pair moves.
44. Your own tokens can share any square. They never lock and never block anyone, and any token can pass any token.
45. A token landing on a normal square captures **every** enemy token there, two or more included. Teammates (a person's two houses) are never captured.
46. Everything else is as above: 6s and extra rolls, stars, the home column, the exact roll to finish, two houses each, the keep-playing vote.

## Known risks (accepted for v1, revisit after playtests)

- A pair parked on a normal square holds back enemy singles until they land on it exactly, and a locked pair can sit stuck through a run of odd rolls.
