# Kill-finisher recording harness (#147 / PR #150), dev-only, not part of the app

- `kills.html`: copy it to the worktree root and run `npx vite`. It mounts the real BoardView, finds a real capture with the engine's own `trayMoves` (a single kill, or a pair taking a pair, on a normal square), and exposes `window.__setup(colour, double, sizePx)` and `window.__play(ms)` (1400 = "full" finishers).
- `rec147.mjs`: `node rec147.mjs http://localhost:5173/kills.html <outDir> <framesDir>` records the 8 cases at 900x1600, DPR 1 (playwright-core, headless Chromium), plus 360dp frames for the sheet. Wait for `networkidle` (Vite's first-load optimise reloads the page).
- `shot.mjs`: screenshots the sheet HTML (built from the frames) into a PNG.
- The GIFs: `ffmpeg -i X.webm -vf "fps=15,scale=360:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" X.gif`.
- The owner wants the next recordings on the **Wooden** board: set the theme before `__setup` (`document.documentElement.dataset.theme = 'wooden'`, see themes.ts).
