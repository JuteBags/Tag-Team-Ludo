// Runs the hidden bench page's GAME REVIEW test (src/ui/bench.ts, #105, #151) headless and prints its lines,
// with the 1/2/3-worker scaling table in the run summary. .github/workflows/review-bench.yml runs it on CI
// against a production build served by `vite preview`.
//   node tools/bench/review-bench.mjs http://localhost:4173/ [chrome path]
import { appendFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [url, executablePath] = process.argv.slice(2);
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const summary = process.env.GITHUB_STEP_SUMMARY;
const md = (line) => {
  console.log(line);
  if (summary) appendFileSync(summary, line + '\n');
};
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
  await page.goto(url + '#bench', { waitUntil: 'networkidle' });
  await page.click('[data-act=review]');
  await page.waitForFunction(() => /\bdone\b|failed|interrupted/.test(document.querySelector('.benchout')?.textContent ?? ''), null, { timeout: 40 * 60 * 1000 });
  const lines = (await page.textContent('.benchout')).split('\n');
  console.log(lines.join('\n'));
  if (!lines.includes('done')) process.exit(1);
  // The table: per game and pool size, the first key verdict, the whole review and the luck pass (seconds).
  const rows = lines.map((l) => /^review (\w+) game \d+, (\d) workers?: first key verdict ([\d.-]+) s, all ([\d.]+) s \(of which the luck pass ([\d.-]+) s/.exec(l)).filter(Boolean);
  const mem = lines.filter((l) => l.startsWith('memory, '));
  md('### The review on a pool of workers (#151): the bench page in headless Chromium on the runner');
  md('');
  md(lines.find((l) => l.startsWith('pool:')) ?? '');
  md('');
  md('| game | workers | first key verdict | whole review | of which the luck pass | speed-up |');
  md('|---|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    const one = rows.find((x) => x[1] === r[1] && x[2] === '1');
    md(`| ${r[1]} | ${r[2]} | ${r[3]} s | ${r[4]} s | ${r[5]} s | ${one ? (Number(one[4]) / Number(r[4])).toFixed(2) + '×' : ''} |`);
  }
  md('');
  for (const m of mem) md(`- ${m}`);
  md('');
} finally {
  await browser.close();
}
