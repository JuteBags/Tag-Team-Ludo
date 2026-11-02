# Tag Team Ludo, "The One Move": treatment

**Style:** Living Screencast (`styles/living-screencast/STYLE.md`).
**Length:** 37.5 s (a 6 s end card, long enough to read the URL).
**Format:** 1920×1080 at 30 fps (the style's rate). A vertical 1080×1920 cut for ads can be rendered from the same timeline later.
**Language:** English.
**Brief (defaults chosen, no questions asked):**
- **No voice-over.** The film has to work with the sound off in feeds and ads, so frosted caption pills carry every line. Music and foley carry the rhythm.
- **No storyboard stop.**
- **Material:** the owner's own product, Tag Team Ludo 2.5.0.

## Departures from the style (decided, and why)
- **The phone screen is the real app, captured at 900×1600 from the 2.5.0 build.** It isn't redrawn. The style wants every pixel redrawn so the camera can go anywhere. For an ad, the product has to be exactly what people install, and the captures are native resolution for every zoom used here (max 1.6×, which is below 1:1 on the capture). Everything around the screen is drawn in code: the window, the camera, the mascot, the touches, the captions and the wipes.
- **A phone in place of a desktop window.** The product is a portrait mobile game, so it floats on a wallpaper as the style's window would.
- **The touch dot stands in for the cursor.** It's still "the user", and never a hand.
- **The mascot stands on hand-measured top edges** of real elements in the captures (button tops, list rows, the board's rim), not on live DOM. The captures don't change, so measuring once is exact.

## Three candidate structures
1. **A day of one player:** morning check-in, a lunch game, an evening streak. Warm, but the check-in and the store are the least distinctive features, and it spreads 34 s thin.
2. **Old way vs new way:** a split screen of plain Ludo against Tag Team Ludo. It reads as a comparison ad, it needs a fake competitor UI, and it makes the review a footnote.
3. **The one move (chosen):** you lose to Extreme; the review finds the single blunder that cost the game; the replay shows the better move; you win the rematch and unlock a skin you can't buy. It has one subject (you), one goal (beat Extreme), one turn (the blunder found), and an ending that echoes (the same result screen, now a win). It puts the 2.5.0 headline feature, the game review, at the turn.

## Logline and arc
A player loses to the Extreme bot; a pixel pawn that lives inside the app digs through the game, finds the one blunder, shows the better move, and the rematch ends in a win streak.
- **Setup (0–9 s):** the app, the levels, Extreme.
- **Turn (9–27 s):** the loss, the review, the blunder, the best move.
- **Ending (27–37.5 s):** the win, the streak reward, the name.

## Benchmark
- **Screen Studio launch recordings**
  - Learn: the camera always explains (push-in on the thing that matters, whip on cause → effect), with captions out of the way.
  - Don't take: their wallpapers, their UI chrome, their cursor art.
- **Duolingo and Monument Valley app-store previews**
  - Learn: a mascot that performs inside the product, and a hook in the first second.
  - Don't take: the owl, their art, their music.

## Mascot ("Tag")
A pawn of big square pixels (12×14 grid) in magenta (#c43cff), a hue the board and UI never use, with two white eyes that carry the acting. Poses: stand, crouch, stretch (jump), cheer, slump, point. It is the game's engine made visible:
- it is born from the board's centre (the match-cut origin);
- it reads the review by running down the rows;
- it stomps the blunder;
- it rides the best-move trail.

## Shot list (camera on the phone screen; z = zoom over the full phone)
| # | t (s) | Screen | Framing and move | Why |
|---|---|---|---|---|
| 1 | 0.0–2.2 | Home | Close (z 1.55) on the hero board, slow drift; the mascot bursts out of the centre palace | Hook in the first second: the board, and a character born from it |
| 2 | 2.2–4.3 | Home | Pull back to the full phone (z 1.0); the mascot hops to VS COMPUTER; touch | The whole product in view, then the first action |
| 3 | 4.3–7.0 | Options | Push in on "How good are the bots?" (z 1.45); the mascot lands on Extreme | Extreme is the promise of the opening |
| 4 | 7.0–9.6 | Game | Medium on the board and the numbered move buttons (z 1.25), slight drift | The game is real and readable |
| 5 | 9.6–11.6 | Loss | Pixel wipe (chapter 02); full phone; the mascot slumps on the ribbon | The setback, held long enough to feel |
| 6 | 11.6–14.6 | Review card | Push in on 47% / 86% (z 1.5), rack to the card | The review's numbers, readable |
| 7 | 14.6–19.0 | Key moves | Follow the mascot down the rows; stomp on "Blunder −10"; spotlight freeze | **Signature shot**: the engine finds the one move |
| 8 | 19.0–23.0 | Replay | Whip-pan in (with blur), push in on the BEST ghost (z 1.6); the mascot runs the dashed trail | Cause → effect: the blunder, then the better move |
| 9 | 23.0–27.0 | Find the better move | Touch on "Find the better move?", slide, touch a marker, the reveal; slow drift | The player tries it themselves |
| 10 | 27.0–31.0 | Win | Pixel wipe (chapter 03); push in on the streak chips; the mascot hops chip to chip to "unlocks Inferno dice" | The payoff, echoing shot 5's result screen |
| 11 | 31.0–37.5 | Home | Pull back to the full phone; the mascot lands on the LUDO logo on the downbeat; end caption with the URL | A diegetic title on the first screen: the bookend |

At least four moves are used: push, pull, drift, whip, follow and the spotlight freeze.

## Beat sheet (seconds)
- 0.0 Black for 3 frames, then the board close-up.
- 0.6 Pixel burst; the mascot is born.
- 1.0 Caption 1.
- 2.2 Pull back.
- 3.4 Hop to VS COMPUTER.
- 3.9 Touch.
- 4.3 App slide to Options.
- 5.3 Hop onto Extreme.
- 5.6 Caption 2.
- 7.0 Slide to the game; caption 3.
- 9.6 Chapter wipe "02 Review".
- 10.1 Slump; caption 4.
- 11.6 Slide to the review card.
- 12.2 Caption 5.
- 14.6 Slide to Key moves.
- 15.0 The mascot runs.
- 17.0 STOMP on the blunder.
- 17.1 Freeze and spotlight; caption 6.
- 19.0 Whip to the replay.
- 19.6 Run the trail.
- 21.2 Point at BEST; caption 7.
- 23.0 Touch "Find the better move?".
- 23.4 Slide.
- 24.6 Touch the marker.
- 25.0 Reveal; caption 8.
- 27.0 Chapter wipe "03 Win".
- 27.5 Hops across the chips.
- 29.4 Landing on "unlocks Inferno dice"; caption 9.
- 31.0 Pixel wipe to Home, pull back.
- 32.1 Landing on LUDO (downbeat).
- 32.2 End caption.
- 34.5 The mascot settles; the end card holds.
- 37.5 End.

## Cue map
- **Tempo:** 112 bpm (beat 0.5357 s), 4/4. Bar 1 starts at 0.0.
- **Bars 1–4 (0–8.6 s), "Play":**
  - jazz bass walking;
  - brushed-feel kit (hi-hat, snare2 rim, kick);
  - vibraphone comping;
  - the chiptune pulse doubles the mascot's moves.
- **8.6–9.6 s:** a tom fill into the chapter wipe.
- **Bars 5–9 (9.6–19.0 s), "Review":**
  - the drums drop to hi-hat only;
  - the bass goes half-time;
  - minor vibes;
  - tension builds to the stomp at 17.0.
  - **Silence 16.6–17.0** (room tone only), then the stomp is the first sound.
- **19.0–27.0 s, "Best move":**
  - the full band comes back;
  - glockenspiel on the BEST point (21.2) and the reveal (25.0).
- **27.0–37.5 s, "Win":**
  - a crash on the wipe;
  - the chiptune lead and the band trade the hook;
  - the final chord on the landing at 32.1;
  - a short ring-out.
- **Hits on the grid:**
  - the stomp lands on the downbeat of bar 9;
  - the 32.1 landing lands on the downbeat of the last bar;
  - touches are quantised to eighths.

## Sound design
| Section | Ambience | Foley | Music |
|---|---|---|---|
| Play | soft room | touches (glass tick), the slides (swish), 8-bit hops and lands, the birth sparkle | full band |
| Review | room | swishes, 8-bit footsteps on the rows, the stomp (8-bit thump plus a sub) | thinned, then a silence |
| Best move | room | whip whoosh, the trail run, a ding on BEST and the reveal | band plus glockenspiel |
| Win | room | wipe sweep, chip hops, coin sparkle | full, then the final chord |

## Subtitle and title design
- **Captions:** frosted-glass pills, bottom centre, in Fredoka 40 px, white on dark glass, with one accent (#ffd65a, the app's gold) for key words. Each is held at least 2.2 s.
- **Chapter pill:** top left, "01 Play", "02 Review", "03 Win".
- **The title is diegetic:** the app's own "TAG TEAM LUDO" logo on the home screen.
- **End caption:** "Free on Android & the web · jutebags.github.io/Tag-Team-Ludo".
