// The app's screens measured the same way every time (#98): a production build in headless Chrome at a phone's
// 390x844, with the CPU throttled (default 4x, a mid-range phone's proxy on an x86 runner). For each screen,
// after it settles, 10 s with no input:
//   - JS heap used / total and DOM nodes (Performance.getMetrics);
//   - frames drawn (compositor DrawFrame) and main-thread paints (Paint), from a trace;
//   - main-thread task time, and its script / style / layout parts, as ms per second.
// And the cold start: first contentful paint, the home screen interactive, and the bytes it fetched. Plus the
// chunk sizes from dist/. Writes the tables to the run summary and perf-screens.json.
//   node tools/perf/screens.mjs <url> [chrome path] [--throttle 4] [--idle 10000]
// .github/workflows/perf-screens.yml runs it against `vite preview` of the build. Every perf: PR runs it
// before and after, so the numbers are comparable.
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const flag = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const pos = args.filter((x, i) => !x.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [url, executablePath] = pos;
const throttle = Number(flag('throttle', 4));
const idleMs = Number(flag('idle', 10000));
const summary = process.env.GITHUB_STEP_SUMMARY;
const md = (line) => {
  console.log(line);
  if (summary) appendFileSync(summary, line + '\n');
};
const link = readFileSync(new URL('./game-seed24.link.txt', import.meta.url), 'utf8').trim();
// --saved saved-games.json (tools/perf/savedgame.ts): continued games with their record, Hard and Extreme bots
// (#176: the game's own review has the person's decisions so far). Without it, the old save (no record).
const savedFile = flag('saved', '');
const saves = savedFile ? JSON.parse(readFileSync(savedFile, 'utf8')) : null;

/** A saved vs Computer game, 4 players, the person (blue) to roll with three tokens out, seeded: Continue opens it. */
function savedGame() {
  const seats = [
    { color: 'blue', owner: 0, bot: false },
    { color: 'green', owner: 1, bot: true, level: 'hard' },
    { color: 'red', owner: 2, bot: true, level: 'hard' },
    { color: 'yellow', owner: 3, bot: true, level: 'hard' },
  ];
  const tokens = { blue: [6, 19, 31, -1], green: [4, 22, -1, -1], red: [12, 27, -1, -1], yellow: [9, 35, -1, -1] };
  const state = { players: seats.map((s) => ({ ...s, tokens: tokens[s.color] })), current: 0, phase: 'roll', dice: null, rolls: [], sixes: 0, moves: [], ranking: [], turnCount: 24, event: null, singles: false };
  // A fixed seed: the dice and the bots' choices come from it and the position, so every run plays the same
  // bots' turns (a perf: PR's before and after compare the same moves).
  return { v: 1, config: { mode: 'pvc', seats, first: 'blue', names: ['You', 'Bot 1', 'Bot 2', 'Bot 3'] }, state, kills: 0, pairs: 0, faces: [], savedAt: Date.now(), seed: 24 };
}

const browser = await chromium.launch(executablePath ? { executablePath } : {});
const rows = [];
let cold = null;
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  // The renderer process's CPU (its main thread, its workers and the compositor), from the browser: what the
  // page's main-thread metrics miss, such as review workers (#176). Seconds.
  const bcdp = await browser.newBrowserCDPSession();
  const rendererCpu = async () => (await bcdp.send('SystemInfo.getProcessInfo')).processInfo.filter((x) => x.type === 'renderer').reduce((t, x) => t + x.cpuTime, 0);
  /** A trace's node (a backend node id) as tag.class#id, or '?' once it's gone. */
  const nodeName = async (backendId) => {
    try {
      await cdp.send('DOM.getDocument', { depth: 0 });
      const { node } = await cdp.send('DOM.describeNode', { backendNodeId: backendId });
      const at = Object.fromEntries((node.attributes ?? []).reduce((r, v, i, a) => (i % 2 ? r : [...r, [v, a[i + 1]]]), []));
      return `${node.nodeName.toLowerCase()}${at.class ? '.' + at.class.trim().split(/\s+/).join('.') : ''}${at.id ? '#' + at.id : ''}`;
    } catch {
      return `node ${backendId}`;
    }
  };

  /** One screen: settle, then `idleMs` with no input, traced. */
  async function measure(name, settle = 1500) {
    await page.waitForTimeout(settle);
    const m0 = await metrics();
    const c0 = await rendererCpu();
    await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'cc', 'disabled-by-default-devtools.timeline', 'toplevel', 'blink', 'v8'] });
    await page.waitForTimeout(idleMs);
    const trace = JSON.parse((await browser.stopTracing()).toString('utf8'));
    const m1 = await metrics();
    const c1 = await rendererCpu();
    const ev = trace.traceEvents ?? trace;
    const count = (n) => ev.filter((e) => e.name === n).length;
    const per = (k) => (1000 * (m1[k] - m0[k])) / idleMs; // seconds of work per second -> ms per second
    // Where the paints go: main-thread paint and raster time (ms per second), and the elements whose layers
    // repaint most (each Paint names its layer's node).
    const durMs = (n) => ev.filter((e) => e.name === n && e.dur).reduce((t, e) => t + e.dur / 1000, 0) * (1000 / idleMs);
    const byNode = new Map();
    for (const e of ev) if (e.name === 'Paint' && e.args?.data?.nodeId) byNode.set(e.args.data.nodeId, (byNode.get(e.args.data.nodeId) ?? 0) + 1);
    const top = [...byNode].sort((x, y) => y[1] - x[1]).slice(0, 4);
    // The renderer's main thread by event, top-level only (each event's time without what it nests in): where
    // the task time goes, in ms per second.
    const mainTid = ev.find((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain')?.tid;
    const spans = ev.filter((e) => e.tid === mainTid && e.ph === 'X' && e.dur > 0).sort((x, y) => x.ts - y.ts || y.dur - x.dur);
    const self = new Map();
    const stack = [];
    for (const e of spans) {
      while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= e.ts) stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) self.set(parent.name, (self.get(parent.name) ?? 0) - e.dur);
      self.set(e.name, (self.get(e.name) ?? 0) + e.dur);
      stack.push(e);
    }
    const busiest = [...self].filter(([n]) => n !== 'RunTask' && n !== 'ThreadControllerImpl::RunTask').sort((x, y) => y[1] - x[1]).slice(0, 8)
      .map(([n, us]) => `${n} ${((us / 1000) * (1000 / idleMs)).toFixed(1)}`);
    const painted = [];
    for (const [id, n] of top) painted.push(`${await nodeName(id)} ${((n * 1000) / idleMs).toFixed(1)}/s`);
    const row = {
      screen: name,
      heapUsedMB: +(m1.JSHeapUsedSize / 1048576).toFixed(2),
      heapTotalMB: +(m1.JSHeapTotalSize / 1048576).toFixed(2),
      nodes: m1.Nodes,
      framesPerS: +((count('DrawFrame') * 1000) / idleMs).toFixed(1),
      paintsPerS: +((count('Paint') * 1000) / idleMs).toFixed(1),
      paintMsPerS: +durMs('Paint').toFixed(1),
      rasterMsPerS: +durMs('RasterTask').toFixed(1),
      painted: painted.join(', '),
      busiest: busiest.join(', '),
      taskMsPerS: +(per('TaskDuration') * 1000).toFixed(1),
      rendererCpuMsPerS: +(((c1 - c0) * 1000 * 1000) / idleMs).toFixed(1),
      scriptMsPerS: +(per('ScriptDuration') * 1000).toFixed(1),
      styleMsPerS: +(per('RecalcStyleDuration') * 1000).toFixed(1),
      layoutMsPerS: +(per('LayoutDuration') * 1000).toFixed(1),
    };
    rows.push(row);
    console.log('SCREEN ' + JSON.stringify(row));
  }
  // The check-in card and the update prompt come up a moment after the home screen: wait a little for one,
  // then close it (Later / Not now).
  const dismiss = async () => {
    const b = await page.waitForSelector('.menu-ov [data-act=later]', { state: 'visible', timeout: 3000 }).catch(() => null);
    if (b) {
      await b.click().catch(() => {});
      await page.waitForSelector('.menu-ov', { state: 'detached', timeout: 3000 }).catch(() => {});
    }
  };

  // 1. Cold start: a fresh context, throttled, to the home screen.
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('[data-mode=pvc]', { state: 'visible' });
  const wall = Date.now() - t0;
  cold = await page.evaluate(() => {
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
    const nav = performance.getEntriesByType('navigation')[0];
    const bytes = performance.getEntriesByType('resource').reduce((s, r) => s + (r.transferSize || r.encodedBodySize || 0), 0) + (nav?.transferSize ?? 0);
    return { fcpMs: fcp && Math.round(fcp), domContentLoadedMs: nav && Math.round(nav.domContentLoadedEventEnd), loadMs: nav && Math.round(nav.loadEventEnd), homeInteractiveMs: Math.round(performance.now()), bytes };
  });
  cold.wallMs = wall;
  console.log('COLD ' + JSON.stringify(cold));
  await dismiss();
  await measure('home');

  // 2. Setup (vs Computer).
  await page.click('[data-mode=pvc]');
  await measure('setup');

  // 3. A game: the person to roll (the saved game, via Continue).
  await page.evaluate((g) => localStorage.setItem('CapacitorStorage.ludo-save', JSON.stringify(g)), saves?.hard ?? savedGame());
  await page.goto(url, { waitUntil: 'load' });
  await dismiss();
  await page.click('[data-act=continue]');
  await page.waitForSelector('[data-act=roll]:not([hidden])', { timeout: 30000 });
  await measure('game, waiting for the roll');

  // 4. The person rolled: pawns to choose from.
  // It pulses (never "stable" to Playwright), so the click goes straight to it.
  await page.$eval('[data-act=roll]', (b) => b.click());
  const movable = await page.waitForSelector('.pawn.movable', { timeout: 30000 }).catch(() => null);
  if (movable) await measure('game, waiting for the move');

  // 5. The person moves; the bots play their turns (busy, not idle).
  if (movable) {
    // A landing marker (boardView .mark): a tap at its centre plays that move (taps are picked by position on
    // the board, so it's a real mouse click there, not an event on the element).
    const box = await ((await page.$('.mark')) ?? movable).boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await measure("game, the bots' turns", 300);
  }

  // 5c. Steady play (#176): the continued Hard game after its review has caught up with the game so far (a
  // 20 s wait at the roll), then a move and the bots' turns: with the live pool this device gets, and with 1
  // live worker (the page reports 3 cores: liveReview.ts livePoolSize gives a computer min(2, cores - 2)).
  if (saves?.hard) {
    const realCores = await page.evaluate(() => navigator.hardwareConcurrency);
    for (const cores of [realCores, 3]) {
      await cdp.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: cores });
      const live = cores <= 2 ? 0 : Math.min(2, cores - 2);
      await page.evaluate((g) => localStorage.setItem('CapacitorStorage.ludo-save', JSON.stringify(g)), saves.hard);
      await page.goto(url, { waitUntil: 'load' });
      await dismiss();
      await page.$eval('[data-act=continue]', (b) => b.click());
      await page.waitForSelector('[data-act=roll]:not([hidden])', { timeout: 30000 });
      await page.waitForTimeout(20000);
      await measure(`steady play, ${live} live worker${live === 1 ? '' : 's'}: waiting for the roll`, 0);
      await page.$eval('[data-act=roll]', (b) => b.click());
      const mv = await page.waitForSelector('.pawn.movable', { timeout: 30000 }).catch(() => null);
      if (mv) {
        const box = await ((await page.$('.mark')) ?? mv).boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await measure(`steady play, ${live} live worker${live === 1 ? '' : 's'}: the bots' turns`, 300);
      }
    }
    await cdp.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: realCores });
  }

  // 5b. The same game against Extreme bots (#176: the game's review pauses while one thinks).
  if (saves?.extreme) {
    await page.evaluate((g) => localStorage.setItem('CapacitorStorage.ludo-save', JSON.stringify(g)), saves.extreme);
    await page.goto(url, { waitUntil: 'load' });
    await dismiss();
    await page.$eval('[data-act=continue]', (b) => b.click());
    await page.waitForSelector('[data-act=roll]:not([hidden])', { timeout: 30000 });
    await page.$eval('[data-act=roll]', (b) => b.click());
    const mv = await page.waitForSelector('.pawn.movable', { timeout: 30000 }).catch(() => null);
    if (mv) {
      const box = await ((await page.$('.mark')) ?? mv).boundingBox();
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await measure("game vs Extreme, the bots' turns", 300);
  }

  // 6. A replay (a shared game's link) and 7. its review.
  await page.goto(url + '#game=' + link, { waitUntil: 'load' });
  await page.waitForSelector('[data-act=review]', { timeout: 30000 });
  await measure('replay');
  await page.click('[data-act=review]');
  await page.waitForFunction(() => /moves reviewed/.test(document.body.textContent ?? ''), null, { timeout: 15 * 60 * 1000 });
  await measure('review (finished)');

  // 8. The store.
  await page.goto(url, { waitUntil: 'load' });
  await dismiss();
  await page.$eval('[data-act=store]', (b) => b.click());
  await measure('store');
} finally {
  await browser.close();
}

// The chunks, from dist/.
const chunks = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = `${d}/${f}`;
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|css|wasm|bin|woff2)$/.test(f)) {
      const b = readFileSync(p);
      chunks.push({ file: p.replace(/^dist\//, ''), raw: b.length, gzip: gzipSync(b, { level: 9 }).length });
    }
  }
};
try {
  walk('dist');
} catch {
  // no dist/ here: the chunk table is left out
}

writeFileSync('perf-screens.json', JSON.stringify({ throttle, idleMs, cold, rows, chunks }, null, 2));
md(`### The app's screens (#98): headless Chrome, 390×844, CPU throttled ${throttle}×, ${idleMs / 1000} s idle per screen`);
md('');
if (cold) md(`**Cold start:** first contentful paint ${cold.fcpMs} ms, home interactive ${cold.homeInteractiveMs} ms (DOMContentLoaded ${cold.domContentLoadedMs} ms, load ${cold.loadMs} ms), ${(cold.bytes / 1024).toFixed(0)} kB fetched.`);
md('');
md('| screen | JS heap used / total (MB) | DOM nodes | frames/s | paints/s | paint ms/s | raster ms/s | main-thread task ms/s | script | style | layout | renderer CPU ms/s |');
md('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const r of rows) md(`| ${r.screen} | ${r.heapUsedMB} / ${r.heapTotalMB} | ${r.nodes} | ${r.framesPerS} | ${r.paintsPerS} | ${r.paintMsPerS} | ${r.rasterMsPerS} | ${r.taskMsPerS} | ${r.scriptMsPerS} | ${r.styleMsPerS} | ${r.layoutMsPerS} | ${r.rendererCpuMsPerS} |`);
md('');
md('| screen | the layers that repaint most |');
md('|---|---|');
for (const r of rows) if (r.painted) md(`| ${r.screen} | ${r.painted} |`);
md('');
md('| screen | the main thread by event (self time, ms/s) |');
md('|---|---|');
for (const r of rows) if (r.taskMsPerS >= 20) md(`| ${r.screen} | ${r.busiest} |`);
md('');
if (chunks.length) {
  md('| chunk | raw kB | gzip kB |');
  md('|---|---:|---:|');
  for (const c of chunks.sort((a, b) => b.raw - a.raw).slice(0, 15)) md(`| ${c.file} | ${(c.raw / 1024).toFixed(1)} | ${(c.gzip / 1024).toFixed(1)} |`);
  md('');
}
