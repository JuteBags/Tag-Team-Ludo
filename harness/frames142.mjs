import { chromium } from 'file:///S:/tools/lemo-opuscar/node_modules/playwright-core/index.mjs';
import { readFileSync } from 'node:fs';
const [url, outDir, linkFile] = process.argv.slice(2);
const link = readFileSync(linkFile, 'utf8').trim();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('CONSOLE', m.text());
  });
  await page.goto(url + '#game=' + link);
  await page.waitForSelector('[data-act=review]', { timeout: 30000 });
  await page.click('[data-act=review]');
  // The review runs in the worker: wait for the run's row.
  await page.waitForFunction(() => [...document.querySelectorAll('.rvrow.roll b')].some((b) => /Three 6s cancelled/.test(b.textContent ?? '')), null, { timeout: 600000 });
  await page.waitForTimeout(1500);
  const rows = await page.$$eval('.rvrow.roll', (els) => els.map((e) => (e.querySelector('b')?.textContent ?? '') + ' | ' + (e.querySelector('small')?.textContent ?? '')));
  console.log(rows.join('\n'));
  const row = page.locator('.rvrow.roll', { hasText: 'Three 6s cancelled' }).first();
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: outDir + '/142-list.png' });
  await row.screenshot({ path: outDir + '/142-row.png' });
  // Tapping the row opens the replay at that roll, with the event as the caption.
  await row.click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: outDir + '/142-replay.png' });
} finally {
  await browser.close();
}
