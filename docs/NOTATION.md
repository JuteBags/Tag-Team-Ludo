# Game notation

A whole game as readable text, a bit like chess's PGN. You can paste it into a chat or an issue, or share it as a tiny file (`.ttl.txt`, UTF-8).

Every pawn has its own letter, and every move says where it lands, so you can follow each pawn through the game.

- **Writing it:** `toNotation` in `src/engine/record.ts`.
- **Reading it back:** `tools/notation.ts` turns it into a game record, for us to debug and study games. The app doesn't import games.

```
[Game "Tag Team Ludo"]
[Blue "Asha"]
[Red "Leo (Bot Extreme)"]
...
; pawns: Blue abcd Green ghij Red mnop Yellow stuv · ...

1. B [1]  R [2]
8. B [2]  R 6 3: p R1 p+3 R4
9. B 6 1: d B1 d+1 B2  R 2: p+2 R6
```

## Pawns

Each house's four pawns have fixed letters, so every game names them the same. The pawn's number in its house is `a`/`g`/`m`/`s` for 1, through `d`/`j`/`p`/`v` for 4.

| House | Pawns |
|---|---|
| Blue | a b c d |
| Green | g h i j |
| Red | m n o p |
| Yellow | s t u v |

## Squares

Each square has a board-wide name. The 52 track squares are four arms of 13. Each arm is named by the colour whose start is its first square, and the squares are numbered 1–13 in the direction of play.

- **The start squares:** `B1`, `G1`, `R1` and `Y1` are the four starts, where a pawn comes out of base. They're stars.
- **The other stars:** `B9`, `G9`, `R9` and `Y9`.
- **Home columns:** `BH1`–`BH5` is Blue's home column (and likewise for the others), and `#` is home.
- **Base:** `base`, used only in position lines.

```
                        G11 G12 G13
                        G10 RH1 R1
     Green              G9  RH2 R2            Red
                        G8  RH3 R3
                        G7  RH4 R4
                        G6  RH5 R5
B13 G1  G2  G3  G4  G5              R6  R7  R8  R9  R10 R11
B12 GH1 GH2 GH3 GH4 GH5      #      YH5 YH4 YH3 YH2 YH1 R12
B11 B10 B9  B8  B7  B6              Y5  Y4  Y3  Y2  Y1  R13
                        B5  BH5 Y6
                        B4  BH4 Y7
     Blue               B3  BH3 Y8            Yellow
                        B2  BH2 Y9
                        B1  BH1 Y10
                        Y13 Y12 Y11
```

For example, Blue's pawns start on `B1`, run up the bottom arm to `B5`, along `B6`–`B13`, then round the board through Green's, Red's and Yellow's arms. They turn into `BH1` after `Y12`.

## Header

PGN-style tags, one per line, then the legend line:

| Tag | |
|---|---|
| `[Game "Tag Team Ludo"]` | always |
| `[App "3.5.0"]` | the app's version |
| `[Date "2026-11-04"]` | the day it was played |
| `[Mode "vs Computer"]` | or `"With friends"` |
| `[Blue "Asha"]`, `[Red "Leo (Bot Extreme)"]` | one per colour in play: the person's name, or a bot's name and level (`(Bot)` when it has none) |
| `[Sides "Asha: Blue, Red; Leo: Green, Yellow"]` | only when someone plays two houses |
| `[First "Blue"]` | who went first |
| `[Doubles "On"]` | or `"Off"` (pairs, locks and blocks off) |
| `[Seed "2026"]` | the game's dice seed, when it has one |
| `[Result "Asha, Leo"]` | the places, first to last; `(stopped)` when the game ended early |
| `[Accuracy "Asha 87%"]` | when the game was reviewed |
| `[Undos "Asha 1"]` | how many undos each person used, when any were |

The colour tags are written in order of who sits where. A shared game carries colours, not people's names (as share links do).

The line after the tags is the legend, a comment (`;`), so anyone pasted a game can read it.

## Moves

The moves come one numbered line per round of turns, with the turns two spaces apart. A new line starts each time play comes back round.

**A turn** is the colour's letter, then the dice as rolled (a 6 rolls again), then `:` and the moves in the order played:

| Notation | Meaning |
|---|---|
| `B 6 4: d B1 d+4 B5` | Blue rolled 6 and 4: pawn d came out on B1, then played the 4 to B5 |
| `s+5 G3` | pawn s plays the 5 and lands on G3 |
| `s Y1` | pawn s comes out of base (that's a 6) |
| `st+4 Y5` | the pair s and t plays the 4 (a pair moves half the die) |
| `b+3 #` | pawn b gets home |
| `n+5 G8 xc` | captures pawn c (`xcd`: two at once, a pair, or doubles off) |
| `\| 6 3: …` | the bonus roll after a capture or a pawn home, and its moves |
| `G [4]` | Green rolled 4 and couldn't move |
| `… m+6 RH5 [3]` | dice in brackets were rolled but nothing could use them |
| `B 6 6 6✕` | three 6s in a row: that run of 6s is cancelled (also read as `666X`) |

**Position lines:** every 20 rounds there's a comment line with where every pawn out of base stands, so a reader can pick the game up anywhere: `; after 40: aG1 bR9 d# nR1 oG1 pG1 (others in base)`.

## Size

Measured on 20 bot games of each kind, with the header, legend and position lines counted:

| Game | Size |
|---|---|
| 2-player | 2.4–4.3 kB |
| 4-player | 6.3–9.8 kB |

## A whole game

Asha (Blue) against Leo, an Extreme bot (Red), with doubles on. This is the sample in `tests/fixtures/notation-2p.json`, and the tests check it never changes.

```
[Game "Tag Team Ludo"]
[App "3.5.0"]
[Date "2026-11-04"]
[Mode "vs Computer"]
[Blue "Asha"]
[Red "Leo (Bot Extreme)"]
[First "Blue"]
[Doubles "On"]
[Seed "2026"]
[Result "Asha, Leo"]
[Undos "Asha 1"]
; pawns: Blue abcd Green ghij Red mnop Yellow stuv · s+5 G3: pawn s plays 5, lands on G3 · s Y1: out · st+4: pair · squares: arm colour + 1-13 from its start, GH1-5 home column, # home · x captures · | bonus roll · [5] unused · 6 6 6✕ cancelled

1. B [1]  R [2]
2. B [5]  R [5]
3. B [5]  R [2]
4. B [2]  R [5]
5. B [5]  R [5]
6. B [1]  R [5]
7. B [2]  R [3]
8. B [2]  R 6 3: p R1 p+3 R4
9. B 6 1: d B1 d+1 B2  R 2: p+2 R6
10. B 2: d+2 B4  R 2: p+2 R8
11. B 6 2: c B1 d+2 B6  R 6 5: p+5 R13 o R1
12. B 3: d+3 B9  R 5: p+5 Y5
13. B 1: d+1 B10  R 3: p+3 Y8
14. B 1: d+1 B11  R 3: p+3 Y11
15. B 3: d+3 G1  R 1: p+1 Y12
16. B 1: d+1 G2  R 5: o+5 R6
17. B 5: d+5 G7  R 4: o+4 R10
18. B 1: d+1 G8  R 5: o+5 Y2
19. B 5: d+5 G13  R 5: o+5 Y7
20. B 1: d+1 R1  R 5: o+5 Y12
; after 20: cB1 dR1 oY12 pY12 (others in base)
21. B 1: d+1 R2  R [5]
22. B 5: d+5 R7  R [1]
23. B 6 2: b B1 d+2 R9  R [3]
24. B 6 2: a B1 d+2 R11  R 4: op+4 B1
25. B 3: d+3 Y1  R 5: o+5 B6
26. B 2: a+2 B3  R 6 3: o+3 B9 n R1
27. B 4: a+4 B7  R 5: o+5 G1
28. B 1: a+1 B8  R 5: n+5 R6
29. B 4: a+4 B12  R 4: n+4 R10
30. B 2: a+2 G1  R 3: n+3 R13
31. B 5: b+5 B6  R 4: n+4 Y4
32. B 5: b+5 B11  R 3: n+3 Y7
33. B 6 6 6✕  R 2: n+2 Y9
34. B 4: d+4 Y5  R 2: n+2 Y11
35. B 6 6 6✕  R 1: n+1 Y12
36. B 5: d+5 Y10  R 5: n+5 B4
37. B 2: d+2 Y12  R 2: n+2 B6
38. B 6 2: b+2 B13 d+6 # | 6 3: b+6 G6 b+3 G9  R 3: n+3 B9
39. B 6 5: b+6 R2 b+5 R7  R 2: n+2 B11
40. B 6 4: c+4 B5 c+6 B11 xn | 2: b+2 R9  R 6 6 4: p+4 B5 n R1 p+6 B11 xc | 3: p+3 G1
; after 40: aG1 bR9 d# nR1 oG1 pG1 (others in base)
41. B 4: b+4 R13  R 5: n+5 R6
42. B 4: b+4 Y4  R 5: n+5 R11
43. B 4: b+4 Y8  R 4: n+4 Y2
44. B 1: b+1 Y9  R 2: n+2 Y4
45. B 4: b+4 BH1  R 2: n+2 Y6
46. B 2: b+2 BH3  R 5: n+5 Y11
47. B 4: a+4 G5  R 1: o+1 G2
48. B 4: a+4 G9  R 5: n+5 B3
49. B 4: a+4 G13  R 2: n+2 B5
50. B 3: b+3 # | 1: a+1 R1  R 4: n+4 B9
51. B 5: a+5 R6  R 3: o+3 G5
52. B 1: a+1 R7  R 4: o+4 G9
53. B 6 1: c B1 a+1 R8  R 4: p+4 G5
54. B 4: a+4 R12  R 1: p+1 G6
55. B 5: a+5 Y4  R 5: p+5 G11
56. B 4: a+4 Y8  R 2: p+2 RH1
57. B 4: a+4 Y12  R 5: p+5 # | 3: o+3 G12
58. B 1: a+1 BH1  R 2: o+2 RH2
59. B 5: a+5 # | 5: c+5 B6  R 2: o+2 RH4
60. B 6 4: c+4 B10 c+6 G3  R 3: n+3 B12
; after 60: a# b# cG3 d# nB12 oRH4 p# (others in base)
61. B 4: c+4 G7  R 4: n+4 G3
62. B 1: c+1 G8  R 5: n+5 G8 xc | 5: n+5 RH1
63. B [4]  R 4: n+4 RH5
64. B [4]  R [4]
65. B [1]  R [3]
66. B [5]  R [5]
67. B [2]  R [5]
68. B [2]  R [4]
69. B 6 5: c B1 c+5 B6  R 2: o+2 # | 6 5: m R1 m+5 R6
70. B 5: c+5 B11  R 2: m+2 R8
71. B 2: c+2 B13  R 2: m+2 R10
72. B 4: c+4 G4  R 6 5: m+5 Y2 m+6 Y8
73. B 2: c+2 G6  R 2: m+2 Y10
74. B 6 1: c+1 G7 c+6 G13  R 4: m+4 B1
75. B 3: c+3 R3  R 5: m+5 B6
76. B 6 3: c+6 R9 c+3 R12  R 6 4: m+4 B10 m+6 G3
77. B 4: c+4 Y3  R 4: m+4 G7
78. B 3: c+3 Y6  R 2: m+2 G9
79. B 1: c+1 Y7  R 2: m+2 G11
80. B 4: c+4 Y11  R 6 3: m+6 RH5 [3]
; after 80: a# b# cY11 d# mRH5 nRH5 o# p# (others in base)
81. B 1: c+1 Y12  R [2]
82. B 1: c+1 BH1  R [3]
83. B 1: c+1 BH2  R [3]
84. B 2: c+2 BH4  R [5]
85. B [6 4]  R [2]
86. B [6 3]  R [4]
87. B 2: c+2 #
```

## Reading a game back

`npx tsx tools/notation.ts game.ttl.txt` prints the game's record as JSON. It replays the game, and checks that every move is legal there and lands on the square the notation names. So a hand-edited game fails loudly instead of quietly turning into a different one. It also reads text a chat app has mangled: collapsed spaces, and `666X` for `6 6 6✕`.
