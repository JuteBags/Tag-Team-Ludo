# Tag Team Ludo, "Ludo, explained": treatment (v2)

**Why a v2:** the owner's feedback on v1 ("The One Move") was that a normal person can't follow it.
- It showed menus and review screens, but never a game being played.
- It used words like "review", "Blunder −10" and "accuracy 47%".
- It cut every 3 seconds.
- It never explained the one new rule.

v2 is for someone who has never seen the app.

**Style:** Living Screencast (`styles/living-screencast/STYLE.md`).
- **Kept from v1:** the real app inside a floating phone, the camera, the pixel wipes, the music, the chiptune foley, and **Tag, the magenta pixel mascot**.
- **What Tag does now:** it is the pointer. It stands on, points at, runs to and stomps the thing the voice is talking about, under a gold dashed spotlight ring.

**Formats:** 1920×1080 and 1080×1920 (`?fmt=v`), 30 fps.

**Languages:** English (voice `bm_george`, Kokoro) and Hindi (Chatterbox multilingual, cleaned take by take: several takes per line, Whisper finds where the line ends, anything said after is cut, and the best-matching take is kept).
- The voice lines are in `voice/script.json`, and captions say exactly what the voice says.
- Each scene's length comes from its line's real length (`out/vo/<lang>/dur.json`), so each language keeps its own pace. That makes 45 to 60 s.

## Rules for a normal viewer
- One idea per scene, said in plain words, with the screen showing exactly that thing, big.
- The game is shown being played: real recordings of the app (dev-session dice forcing to stage the positions; no app changes).
- A caption is never shorter than its reading time (the library's readcheck), and long lines wrap to two lines.

## Scenes
| # | Voice (English) | Picture | Tag |
|---|---|---|---|
| 1 | This is Ludo. The game you already know. | Clip D: roll a 6, roll again, a token comes out, then it captures a red token (the app's own KILL! effect) | Born from the board's centre, watches from the rim, cheers on the capture |
| 2 | One new rule. Two of your tokens on one square make a pair. | Clip A, close up: the second blue token lands on the first, and the pair badge appears | Stands over the square; "!" and a spotlight when the pair forms |
| 3 | A pair moves together. | Clip B: "Pair +2", and both tokens move as one | Runs alongside, cheers |
| 4 | And it blocks the way. Other tokens can't pass it. | Clip C1: red rolls a 4 behind the pair; "No moves" | Points at the red token from the pair |
| 5 | Play with friends on one phone, or against the computer, from Easy to Extreme. | Home, then the level picker lighting up Easy, Normal, Hard and Extreme | On WITH FRIENDS, then VS COMPUTER (tap), then hops chip to chip; cheers on Extreme |
| 6 | After every game, the app shows you the one move that lost it, and the better move you missed. | Key moves (stomp on the Blunder row), then the replay with the BEST ghost | Runs, stomps, then points at BEST |
| 7 | Win in a row, and unlock special dice and pawns. | The result screen with the streak reward | Hops to the reward and cheers |
| 8 | Tag Team Ludo. Free, and it works offline. On Android and the web. | Home, with the end card (name, line, URL) | Lands on the LUDO logo on the final chord |

## Sound
- **Band:** jazz bass, vibraphone and a light kit in F at 112 bpm, ducked about 9 dB under the voice. The final chord lands with Tag on the logo.
- **Tag's chiptune voice:** on every move it makes, plus glockenspiel dings when a spotlight lights.
- **Game foley:** dice rattles, taps, the "six" fanfare, the capture hit, and the "no moves" buzz.
- **Voice:** compressed 3:1, high-passed, with a touch of room, about 10 dB over the music. The master is −14 LUFS.

## Build
`LIB=… LANG_FILM=en|hi sh build.sh`, on GitHub Actions only (`demo-film.yml`, run by hand).
- Order: clip frames, then the voice (`tts.py`), then events, the mix and captions, then the 16:9 and 9:16 picture, then the masters and posters.
- The checks: Whisper on the English lines, loudness, black frames, readcheck in both shapes, and contact sheets.
