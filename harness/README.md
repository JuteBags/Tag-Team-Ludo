# Kill-finisher harness, fixed (#150), dev-only, not part of the app

Use these files. The #147 harness on `assets/pr-147` renders a wrong board: it never mounts the app's shared
SVG `<defs>` and has no `.gboard` perspective, so the base panels, the tile and pawn gradients and the tilt are
all missing.

- `kills-ux.html`: copy it to the worktree root and run `npx vite --port 5197`.
  - It mounts `globalDefs()` (art.ts) as app.ts does, and puts the board in `.gboard` like the game screen.
  - `window.__setup(colour, double, sizePx, theme = 'wood', tilted = true)`: the theme ids are `classic`,
    `wood`, `dark`, `metal`, `tron` and `halloween`. It's `wood`, not `wooden`.
  - `window.__play(ms)`: 1400 = "full" finishers.
- `cap150.mjs`: `node cap150.mjs <outDir> <colour> <double 0|1> <theme> [tilted 1|0] [from] [to] [step]`. It saves
  360x640 DPR-2 screenshots every `step` ms through the finisher.
- `rec150.mjs`: `node rec150.mjs <outDir> <colour> <double 0|1> <theme>`. It records a 450x800 webm.
- Both use playwright-core from `S:/tools/lemo-opuscar/node_modules` and expect the server on port 5197.
- GIF: `ffmpeg -i X.webm -vf "crop=450:560:0:30,fps=15,scale=360:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" X.gif`.
