// Records the 8 kill finishers (4 colours x single/double) from the local harness (kills.html): 900x1600 webm
// at DPR 1 into demo/kills/, and 360dp frames (at 25/45/65/85% of each finisher) for the sheet.
import { chromium } from 'file:///S:/tools/lemo-opuscar/node_modules/playwright-core/index.mjs';
import { mkdirSync, renameSync, existsSync, rmSync } from 'node:fs';
const [url, outDir, framesDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
mkdirSync(framesDir, { recursive: true });
const cases = [];
for (const c of ['green', 'red', 'blue', 'yellow']) for (const d of [false, true]) cases.push([c, d]);
const browser = await chromium.launch();
const log = [];
try {
  for (const [colour, double] of cases) {
    const name = `${colour}-${double ? 'double' : 'single'}`;
    // The recording: 900x1600, DPR 1.
    const ctx = await browser.newContext({ viewport: { width: 900, height: 1600 }, deviceScaleFactor: 1, recordVideo: { dir: outDir, size: { width: 900, height: 1600 } } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR', name, String(e)));
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof window.__setup === 'function');
    const info = await page.evaluate(([c, d]) => window.__setup(c, d, 820), [colour, double]);
    await page.waitForTimeout(700);
    const ms = await page.evaluate(() => window.__play(1400));
    await page.waitForTimeout(900);
    const video = page.video();
    await page.close();
    await ctx.close();
    const path = await video.path();
    const dest = `${outDir}/${name}.webm`;
    if (existsSync(dest)) rmSync(dest);
    renameSync(path, dest);
    log.push({ name, ...info, ms });
    console.log(JSON.stringify({ name, ...info, ms }));
    // The 360dp frames: the same case at 360 wide, screenshots through the finisher.
    const p2 = await browser.newPage({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2 });
    await p2.goto(url, { waitUntil: 'networkidle' });
    await p2.waitForFunction(() => typeof window.__setup === 'function');
    await p2.evaluate(([c, d]) => window.__setup(c, d, 340), [colour, double]);
    await p2.waitForTimeout(500);
    const t0 = Date.now();
    const playing = p2.evaluate(() => window.__play(1400));
    for (const f of double ? [900, 1600, 2300, 3000] : [900, 1400, 1900, 2500]) {
      const at = t0 + f;
      const left = at - Date.now();
      if (left > 0) await p2.waitForTimeout(left);
      await p2.screenshot({ path: `${framesDir}/${name}-${f}.png` });
    }
    await playing;
    await p2.close();
  }
} finally {
  await browser.close();
}
console.log('DONE ' + JSON.stringify(log));
