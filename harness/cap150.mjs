// #150 frames: a finisher at 360dp, shot every `step` ms, with the page's animations paused for each shot.
// node cap150.mjs <outDir> <colour> <double 0|1> <theme> [tilted 1|0] [from] [to] [step]
import { chromium } from 'file:///S:/tools/lemo-opuscar/node_modules/playwright-core/index.mjs';
import { mkdirSync } from 'node:fs';
const [out, colour, dbl, theme, tilt = '1', from = '500', to = '3200', step = '150'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const url = 'http://localhost:5197/kills-ux.html';
const b = await chromium.launch();
try {
  const p = await b.newPage({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2 });
  p.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
  await p.goto(url, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => typeof window.__setup === 'function');
  const info = await p.evaluate(([c, d, t, tl]) => window.__setup(c, d, 340, t, tl), [colour, dbl === '1', theme, tilt === '1']);
  console.log(JSON.stringify(info));
  await p.waitForTimeout(600);
  // Fake time: animations are paused, then each frame steps every animation's currentTime forward.
  const name = `${colour}-${dbl === '1' ? 'double' : 'single'}-${theme}${tilt === '1' ? '' : '-flat'}`;
  const t0 = Date.now();
  const playing = p.evaluate(() => window.__play(1400));
  for (let f = +from; f <= +to; f += +step) {
    const left = t0 + f - Date.now();
    if (left > 0) await p.waitForTimeout(left);
    await p.screenshot({ path: `${out}/${name}-${String(f).padStart(4, '0')}.png` });
  }
  console.log('ms', await playing);
} finally {
  await b.close();
}
