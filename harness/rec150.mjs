// #150: records a finisher at phone size (450x800 CSS px, DPR 2 frames are too big for a GIF; video is 450x800).
// node rec150.mjs <outDir> <colour> <double 0|1> <theme>
import { chromium } from 'file:///S:/tools/lemo-opuscar/node_modules/playwright-core/index.mjs';
import { mkdirSync, renameSync, existsSync, rmSync } from 'node:fs';
const [out, colour, dbl, theme] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const name = `${colour}-${dbl === '1' ? 'double' : 'single'}-${theme}`;
const b = await chromium.launch();
try {
  const ctx = await b.newContext({ viewport: { width: 450, height: 800 }, deviceScaleFactor: 1, recordVideo: { dir: out, size: { width: 450, height: 800 } } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
  await p.goto('http://localhost:5197/kills-ux.html', { waitUntil: 'networkidle' });
  await p.waitForFunction(() => typeof window.__setup === 'function');
  await p.evaluate(([c, d, t]) => window.__setup(c, d, 430, t, true), [colour, dbl === '1', theme]);
  await p.waitForTimeout(700);
  console.log(name, 'ms', await p.evaluate(() => window.__play(1400)));
  await p.waitForTimeout(800);
  const v = p.video();
  await p.close();
  await ctx.close();
  const dest = `${out}/${name}.webm`;
  if (existsSync(dest)) rmSync(dest);
  renameSync(await v.path(), dest);
} finally {
  await b.close();
}
