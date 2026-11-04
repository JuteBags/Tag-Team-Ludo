# Tag Team Ludo: design philosophy

Owner of this file: the UI/UX session (ludo-uiux). Approved by the PM (ludo-pm) on 2026-11-04. Written 2026-11-04 after reading the three design skills
(Painter, tasteskill v2, Lemo-Opuscar) and the PM's KT. The owner's rules beat everything here; this file beats the
skills.

## The one idea

**The board is a table, the screens are a scorecard, the big moments are films.**

Tag Team Ludo is a game you hold in one hand. It has three kinds of surface, and each kind has its own rules. Most
conflicts between the skills disappear once you ask which register a pixel belongs to.

| Register | What is in it | Voice | Rulebook it borrows from |
| --- | --- | --- | --- |
| **Play** | Board, pawns, dice, tray, landing markers, avatars, the turn | Tactile and physical. Objects have weight, depth and material. | Painter: skeuomorphism for games, touch psychology, spatial truth in motion |
| **Spectacle** | Kill finishers, palace cutscene, home banner, win screen, unlocks | Showy, long if it reads, always skippable | Lemo-Opuscar's DIRECTOR.md: hook, one native move, beat sheet, sound and rhythm first |
| **Information** | Review, Luck-O-Meter, stats, achievements, store lists, settings, setup questions | Quiet, flat, the number first | tasteskill `app-screens.md`: colour on data not chrome, KPIs as type, honest states |

The home screen sits between Play and Information. Its tiles are Play objects (you press them like pieces), and its
captions are Information.

## Principles

1. **Say less (owner).** Show the number, not a word that repeats it. "69%", never "a bit lucky". Text stays only
   when it carries something that isn't visible anywhere else (a why line, "+N% to win").
2. **Colour means a player first.** Red, Green, Yellow and Blue belong to the houses and to nothing else. Data uses
   Okabe-Ito: accuracy is sky blue `#56B4E9` (solid), luck is orange `#E69F00` (dashed). The review's labels use the rest of the Okabe-Ito set (#162): Best `#3ccf9e`, Good `#8fdcc0`, Inaccuracy `#f0e442`, Mistake `#ff6f3c`, Blunder `#e58bc0`, all from `LABEL_LOOK`. Good and bad are never
   shown by red and green alone; give them a shape, a sign or a position too. Colour-blind symbols are a
   first-class mode, so check them in every review.
3. **Physical truth on the board.** A pawn enters from where it was and leaves toward where it goes. Layer order is
   a promise: board, then effects in the ground (pits, cracks, shadows), then pieces, then marks, then badges.
   Whatever happens *to* a pawn draws under it or occludes it the way a real object would (#147's pit goes under
   the pawn, and the rim lip hides it).
4. **The thumb decides the layout.** Actions you take every turn (the dice, the tray, landing markers) sit in the
   bottom third. Hit areas are at least 44 px, and taps go to the nearest legal target (`HIT`), never to a precise
   hit box. One primary action per screen.
5. **Every animation answers "what changed?".** In Play, moves are short and decisive: hops, captures and dice
   use springs, because they are objects. In Information, motion only conveys state (150–250 ms, expo-out, no
   bounce). In Spectacle, a moment may run 2.5–3 s or more if a thumbnail-sized viewer can read it. Under
   reduced motion it becomes one still frame, never a blank.
6. **One system, many skins.** Themes and store skins are costumes. They may break the chrome rules (Tron is neon
   on black, and that is the product). Default chrome never borrows a skin's tricks. A new theme is one block of
   `--b-*` variables plus part classes. It is never a fork of the art.
7. **Information screens are scorecards, not dashboards.** Sentence-case labels at 12–14 px, figures in tabular
   digits, one hue per chart, no tracked uppercase eyebrows ("YOUR WINNING CHANCES" becomes "Win %"), no icon
   tiles, zeros printed as 0.
8. **The phone screenshot is the judge.** Every UI change ships with screenshots at 360 dp, at a tall 1080×2400,
   and tilted. Board work also needs the **Wooden** board plus one Classic frame. They go in the PR body via an
   `assets/pr-N` branch.
9. **Options before big changes.** A visible change to the board, a screen layout or a default theme goes to the
   owner as 2–3 options with images. The owner picks.

## The UI/UX gate (owner rule, 2026-11-04)

The UI/UX session signs off on every SD or JD feature with a visible change: a screen, row, text, button, chart,
animation, sound or theme.

1. **Before building:** the dev sends the UI part of the design (a mock-up or a written layout). The UI/UX session
   replies on the issue with approval or changes, judged against this file and the owner's rules.
2. **Before the PR is marked ready:** the dev posts frames at 360 dp, plus tall and tilted where layout changes, in
   the PR body. The UI/UX session comments "UI/UX: approved" or lists the changes.
3. **The PM doesn't approve** a PR with a visible change until that approval comment is on it.
4. **Exempt:** dev-only pages (`#bench`, harnesses) and pure logic.

Reviews check only what the PR adds. Older problems found along the way go to their own issue.

## Where the skills disagree, and the ruling

| Conflict | Painter | tasteskill | Lemo | Ruling |
| --- | --- | --- | --- | --- |
| Gradients | Allowed in styles (aurora, skeuomorphism) | Banned everywhere | n/a | **Play**: allowed when they depict material (gold frame, wood, die faces). **Information**: banned. Buttons keep the game's single 3D-button recipe (`.b3`) and get no new variants. |
| Shadows at rest | Multi-layer shadows for craft | Banned except on what floats | n/a | **Play**: yes, objects sit on a table. **Information**: a tone step instead. |
| Glass / neon on dark | Glass "sparingly", neon banned as slop | Both banned | n/a | Banned in chrome. Allowed inside a skin (Tron, Halloween). |
| Spring / bounce easing | Spring 300/20 for playful UI | Bounce and elastic banned | n/a | Springs for objects (pawn hops, dice, coins). Expo-out for UI panels and sheets. No bounce on text. |
| Motion length | 150–800 ms by size | A motion budget (built for web pages) | A film's rhythm | Play ≤ 400 ms per beat. Info 150–250 ms. Spectacle by beat sheet, can be long (owner: "long and showy if it reads"). Taste's "≥ 8 moving elements" rule is for scrolled pages and doesn't apply. |
| Uppercase | n/a | Tracked tiny caps banned | n/a | Lilita One caps on buttons and banners are the game's voice and stay. Small tracked caps labels go. |
| Emoji | n/a | Banned as icons | n/a | Fun Emoji avatars are characters, and they stay (CC BY credit). Emoji as bullets or chips (🔥, 🏆 in reward pills) get replaced with our own vector glyphs. |
| Numbering | n/a | Index numbers banned | n/a | Ranks (1st, 2nd), pawn numbers (1–4) and dice are data, so they stay. |
| Colour system | OKLCH, never `#000`/`#fff` | The dealt palette | The style's palette | House colours plus Okabe-Ito for data are fixed by the owner. OKLCH and tinted neutrals for any new chrome tokens. `#000` only inside a skin. |
| Modals | Last resort | n/a | n/a | Game convention allows a sheet for pause, settings and reward. No modal for anything that could be inline (results, explanations). |
| Copy | Verb + object labels, rich empty states | Write the full content | Subtitles on every line | Verb + object on buttons ("Play again", "Collect 20"). Short empty states: one line, no illustration. The owner's "say less" wins over "write the full content". |
| Process | Godmode loop, Nielsen score | draw.mjs direction, inspect.mjs at 1440/768/390 | Treatment → style frames → review | No dealt directions: the game already has a look, so this is a restyle, not a new direction. The inspector doesn't fit a fixed 390×844 stage. **My loop:** write a design note, make 2–3 options with frames, the owner picks, build in my worktree, take phone screenshots at 360 dp, tall and tilted, critique them with taste's `critique.md` passes and Painter's heuristics, fix the top 3, then PR. Spectacle moments also get a short beat sheet (Lemo §4) before code. |

## Where they agree (taken as is)

- Hierarchy through size, contrast and space. A type scale ratio of 1.25× or more, and five sizes at most per screen.
- Two typefaces: Lilita One for display, Nunito for text. No third.
- Visible focus, alt text and accessible names on every control. `prefers-reduced-motion` on every effect.
- Animate only transform and opacity, at 60 fps on a mid-tier phone. Effects use rAF with a timeout fallback
  (AGENTS.md).
- Skeleton or progress over a spinner (review ETA). Undo over confirm. Undo is a compact icon with "x/2" and is never
  called out in results.
- Honest data: no invented numbers, and totals add up.

## Proposals from the first audit (not decisions)

Each of these is a visible change, so under principle 9 it goes to the owner as an option with images before
anyone builds it. Checked against `main` on 2026-11-04.

- **Tracked-caps labels left on main.**
  - `.lbl`: the home "Players" label and the setup questions, which are whole sentences set in caps.
  - `.achg`: the achievement group headings.
  - `.rvhead`: the review section headings.
  - Proposal: sentence case at 13–14 px. The graph title is already "Win %" (#146).
  - `.cs-top`, the kingdom name in the palace cutscene, is Spectacle and stays.
- **Review copy (#152, after JD's #142 merges).**
  - `rollText` still says "Your lucky 4: +17", and the headline says "unlucky rolls".
  - The units are mixed: "+17" next to "−6% to win".
  - #149 already removed "a bit unlucky".
- **Result screen.** It shows seven reward pills with emoji chips (🔥, 🏆) and a sentence-long breakdown.
  Proposal: a big coin total, the unlock first, the breakdown collapsed, and our own vector glyphs instead of emoji.
- **Game header.** "VS COMPUTER / 2 PLAYERS" repeats what the seats already show. Proposal: cut it, or shrink it into
  the pause menu.
- **Home footer.** It has two lines of small grey meta. Proposal: move the version and the avatar credit into
  Settings → About.
- **Board look:** decided on #162. Classic stays the default, as it was in 2.5.0. The bad look in #150 came from the camera zoom, the dim and a broken harness, not from the board.
