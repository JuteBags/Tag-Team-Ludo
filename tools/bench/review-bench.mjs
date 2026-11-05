// Runs the hidden bench page's GAME REVIEW test (src/ui/bench.ts, #105, #151) headless and prints its lines,
// with the 1/2/3(/4/6)-worker scaling table in the run summary. .github/workflows/review-bench.yml runs it on CI
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
  // Which engine build the page and its workers fetched (#151: simd, or plain where SIMD is missing or ?wasm=plain).
  const fetched = new Set();
  page.on('request', (r) => { const f = r.url().split('/').pop(); if (f.endsWith('.wasm')) fetched.add(f.replace(/-[\w-]{8}\.wasm$/, '.wasm')); });
  await page.goto(url + '#bench', { waitUntil: 'networkidle' });
  await page.click('[data-act=review]');
  await page.waitForFunction(() => /\bdone\b|failed|interrupted/.test(document.querySelector('.benchout')?.textContent ?? ''), null, { timeout: 40 * 60 * 1000 });
  const lines = (await page.textContent('.benchout')).split('\n');
  console.log(lines.join('\n'));
  console.log(`engine files fetched: ${[...fetched].sort().join(', ') || 'none seen'}`);
  if (!lines.includes('done')) process.exit(1);
  // The table: per game and pool size, the first key verdict, the whole review and the luck pass (seconds).
  const rows = lines.map((l) => /^review (\w+) game \d+, (\d) workers?: first key verdict ([\d.-]+) s, all ([\d.]+) s \(of which the luck pass ([\d.-]+) s/.exec(l)).filter(Boolean);
  const mem = lines.filter((l) => l.startsWith('memory, '));
  md('### The review on a pool of workers (#151): the bench page in headless Chromium on the runner');
  md(`engine files fetched: ${[...fetched].sort().join(', ') || 'none seen'}`);
  md('');
  md(lines.find((l) => l.startsWith('pool:')) ?? '');
  md('');
  // The serial share (Amdahl): with T1 on one worker and Tn on n, s = (Tn/T1 - 1/n) / (1 - 1/n). It's what
  // caps the speed-up at 1/s however many cores; a pool bigger than the runner's cores inflates it.
  md('| game | workers | first key verdict | whole review | of which the luck pass | speed-up | serial share |');
  md('|---|---:|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    const one = rows.find((x) => x[1] === r[1] && x[2] === '1');
    const n = Number(r[2]);
    const ratio = one ? Number(r[4]) / Number(one[4]) : NaN;
    const serial = n > 1 && one ? (((ratio - 1 / n) / (1 - 1 / n)) * 100).toFixed(0) + ' %' : '';
    md(`| ${r[1]} | ${r[2]} | ${r[3]} s | ${r[4]} s | ${r[5]} s | ${one ? (1 / ratio).toFixed(2) + '×' : ''} | ${serial} |`);
  }
  md('');
  // The time-left estimate (reviewRun.ts eta) at 10/25/50 % of the decisions, against the real time left.
  const etas = lines.map((l) => /^eta (\w+) game \d+, (\d) workers?: (.*)$/.exec(l)).filter(Boolean);
  if (etas.length) {
    md('| game | workers | at 10 %: shown / real | at 25 % | at 50 % |');
    md('|---|---:|---|---|---|');
    for (const e of etas) {
      const cells = e[3].split('; ').map((c) => {
        const x = /shows ([\d-]+)(?: s)?, really (\d+) s/.exec(c);
        if (!x) return c;
        const ratio = x[1] === '-' || Number(x[2]) === 0 ? '' : ` (${(Number(x[1]) / Number(x[2])).toFixed(1)}×)`;
        return `${x[1]}${x[1] === '-' ? '' : ' s'} / ${x[2]} s${ratio}`;
      });
      md(`| ${e[1]} | ${e[2]} | ${cells.join(' | ')} |`);
    }
    md('');
  }
  for (const m of mem) md(`- ${m}`);
  // The review while the game is played (#176): ready after the end, and Extreme's think beside it.
  const live = lines.filter((l) => l.startsWith('live') || l.startsWith('extreme think') || l.startsWith('strip '));
  if (live.length) {
    md('');
    md('**The review while the game is played (#176)**');
    md('');
    for (const l of live) md(`- ${l}`);
  }
  md('');
} finally {
  await browser.close();
}
