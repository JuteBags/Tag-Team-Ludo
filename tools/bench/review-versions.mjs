// The game review's time through the app itself, for comparing versions (#176 follow-up: v4's cost against
// v2.5.0): opens the review test's two games (src/ui/bench.ts REVIEW_GAMES, seat 0 a person) from a share
// link, taps Review, and times it to "N moves reviewed", sampling the progress line (with its time-left
// estimate) as it goes. The page's core count is overridden, so main's pool of workers is 1 with --cores 2.
//   node tools/bench/review-versions.mjs <url> <chrome path> --bench src/ui/bench.ts --label main [--cores 2] [--runs 2]
// .github/workflows/review-versions.yml runs it on main's build and on a tag's, the same runner.
import { appendFileSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const flag = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const [url, executablePath] = args.filter((x, i) => !x.startsWith('--') && !args[i - 1]?.startsWith('--'));
const label = flag('label', 'build');
const cores = Number(flag('cores', 2));
const runs = Number(flag('runs', 2));
const summary = process.env.GITHUB_STEP_SUMMARY;
const md = (line) => {
  console.log(line);
  if (summary) appendFileSync(summary, line + '\n');
};

// The games, as bench.ts writes them out (layout, seed, events in '...' + '...' pieces).
const src = readFileSync(flag('bench', 'src/ui/bench.ts'), 'utf8');
const block = src.slice(src.indexOf('export const REVIEW_GAMES'));
const games = [...block.matchAll(/layout: '(2p|4p)',\s*seed: (\d+),\s*events:\s*((?:'[^']*'\s*\+?\s*)+)/g)].map((m) => ({ layout: m[1], seed: Number(m[2]), events: [...m[3].matchAll(/'([^']*)'/g)].map((x) => x[1]).join('') }));
if (games.length !== 2) throw new Error(`found ${games.length} review games in the bench`);
const COLORS = { '2p': ['blue', 'red'], '4p': ['blue', 'green', 'red', 'yellow'] };

/** The share link's fragment (record.ts encodeRecord: deflate-raw JSON, base64url). */
async function encode(rec) {
  const stream = new Blob([JSON.stringify(rec)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const browser = await chromium.launch(executablePath ? { executablePath } : {});
const rows = [];
try {
  for (const g of games) {
    const seats = COLORS[g.layout].map((color, owner) => ({ color, owner, bot: owner !== 0, ...(owner ? { level: 'hard' } : {}) }));
    const rec = { v: 1, seats, first: seats[g.seed % seats.length].color, seed: g.seed, events: g.events };
    const link = await encode(rec);
    for (let r = 0; r < runs; r++) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: cores });
      await page.goto(`${url}#game=${link}`, { waitUntil: 'load' });
      await page.waitForSelector('[data-act=review]', { timeout: 60000 });
      await page.$eval('[data-act=review]', (b) => b.click());
      const t0 = Date.now();
      const samples = [];
      let done = null;
      while (Date.now() - t0 < 20 * 60 * 1000) {
        const text = await page.$eval('.rvprog span', (e) => e.textContent ?? '').catch(() => '');
        const t = (Date.now() - t0) / 1000;
        if (/moves reviewed/.test(text)) {
          done = t;
          break;
        }
        const m = /(\d+) of (\d+)/.exec(text);
        if (m && (!samples.length || samples.at(-1).text !== text)) samples.push({ t, done: Number(m[1]), of: Number(m[2]), text });
        await page.waitForTimeout(200);
      }
      // The progress line at 10/25/50 % of the decisions: its estimate, and the real time left.
      const at = (share) => {
        const s = samples.find((x) => x.done / x.of >= share);
        if (!s) return '-';
        const eta = /·\s*(.*)$/.exec(s.text)?.[1] ?? '(none)';
        return `${eta} / ${done === null ? '?' : (done - s.t).toFixed(0)} s`;
      };
      const row = { label, layout: g.layout, seed: g.seed, cores, run: r + 1, seconds: done, eta10: at(0.1), eta25: at(0.25), eta50: at(0.5) };
      rows.push(row);
      console.log('REVIEW ' + JSON.stringify(row));
      await context.close();
    }
  }
} finally {
  await browser.close();
}
md(`### The review through the app: ${label}, ${cores} cores reported (main's pool: ${Math.max(1, cores - 1)} worker${cores > 2 ? 's' : ''})`);
md('');
md('| build | game | run | review time | at 10 %: shown / really left | at 25 % | at 50 % |');
md('|---|---|---:|---:|---|---|---|');
for (const r of rows) md(`| ${r.label} | ${r.layout} ${r.seed} | ${r.run} | ${r.seconds === null ? 'timed out' : r.seconds.toFixed(1) + ' s'} | ${r.eta10} | ${r.eta25} | ${r.eta50} |`);
md('');
