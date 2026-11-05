// The review screen's cost (#98 target 3): the Scorecard (#174) on a 2p and a 4p game from a link, in a production
// build in headless Chrome at 390x844 with the CPU throttled (default 4x), like screens.mjs. Per game:
//   - while the review runs: how often the screen redraws, and the main thread's time (script / style / layout)
//     per redraw and per second, the long tasks;
//   - finished, after a GC: DOM nodes (all, and the elements of each part: the card, the graph, the key moments,
//     the strip), the JS heap against the replay screen before it, and 5 s idle;
//   - each tap, to the next frame: "Show N more", a count's filter, the graph's tabs, the other side's review;
//   - the heap left after going back home (against the home screen's before: what stays once it's closed);
//   - reopening it (the link's replay again, then review): to the first draw and to the finished screen.
// Writes the tables to the run summary and perf-review.json.
//   node tools/perf/review.mjs <url> [chrome path] [--throttle 4] [--out perf-review.json] [--label main]
// .github/workflows/perf-screens.yml runs it next to screens.mjs.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const flag = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const pos = args.filter((x, i) => !x.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [url, executablePath] = pos;
const throttle = Number(flag('throttle', 4));
const outFile = flag('out', 'perf-review.json');
const label = flag('label', '');
const summary = process.env.GITHUB_STEP_SUMMARY;
const md = (line) => {
  console.log(line);
  if (summary) appendFileSync(summary, line + '\n');
};
const games = [
  ['2p', readFileSync(new URL('./game-seed24.link.txt', import.meta.url), 'utf8').trim()],
  ['4p', readFileSync(new URL('./game-4p-seed24.link.txt', import.meta.url), 'utf8').trim()],
  // The person played by Easy: enough key moves for "Show N more".
  ['4p, Easy person', readFileSync(new URL('./game-4p-easy-seed24.link.txt', import.meta.url), 'utf8').trim()],
];

const browser = await chromium.launch(executablePath ? { executablePath } : {});
const out = [];
try {
  for (const [name, link] of games) {
    try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const gc = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      await page.waitForTimeout(300);
    };
    const heapMB = async () => {
      await gc();
      const m = await metrics();
      return { heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(2), nodes: m.Nodes };
    };
    /** Elements in each part of the screen (and in the whole screen). */
    const parts = () =>
      page.evaluate(() => {
        const n = (s) => {
          const e = document.querySelector(s);
          return e ? e.querySelectorAll('*').length + 1 : 0;
        };
        return { screen: n('.screen.review'), card: n('.rvcards'), graph: n('.rvgraph'), list: n('.rvlist'), rows: document.querySelectorAll('.rvlist .rvrow').length, strip: n('.rvstrip'), cells: document.querySelectorAll('.rvstrip i').length, document: document.querySelectorAll('*').length };
      });
    /** A tap, timed in the page from the click to the next frame (two rAFs: the frame that shows it has run). */
    const tap = (sel) =>
      page.evaluate(
        (s) =>
          new Promise((res) => {
            const e = document.querySelector(s);
            if (!e) return res(null);
            const t = performance.now();
            e.click();
            requestAnimationFrame(() => requestAnimationFrame(() => res(+(performance.now() - t).toFixed(1))));
          }),
        sel,
      );
    /**
     * The JS heap by kind, from a heap snapshot (after a GC): self size per node type, and per type:name for the
     * biggest, so a difference says what stayed (code, closures, arrays, strings, objects by constructor).
     */
    const heapKinds = async () => {
      await gc();
      const chunks = [];
      const onChunk = (c) => chunks.push(c.chunk);
      cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
      const snap = JSON.parse(chunks.join(''));
      const f = snap.snapshot.meta.node_fields;
      const types = snap.snapshot.meta.node_types[0];
      const [ti, ni, si] = [f.indexOf('type'), f.indexOf('name'), f.indexOf('self_size')];
      const byType = {};
      const byName = {};
      for (let i = 0; i < snap.nodes.length; i += f.length) {
        const type = types[snap.nodes[i + ti]];
        const size = snap.nodes[i + si];
        byType[type] = (byType[type] ?? 0) + size;
        const nm = type === 'object' || type === 'closure' || type === 'code' || type === 'native' ? `${type}:${String(snap.strings[snap.nodes[i + ni]]).replace(/\s+/g, ' ').slice(0, 60)}` : type;
        byName[nm] = (byName[nm] ?? 0) + size;
      }
      return { byType, byName };
    };
    /** What grew from `a` to `b`, in kB, biggest first. */
    const grew = (a, b, n = 10) =>
      Object.keys(b)
        .map((k) => [k, (b[k] - (a[k] ?? 0)) / 1024])
        .filter(([, kb]) => Math.abs(kb) >= 8)
        .sort((x, y) => y[1] - x[1])
        .slice(0, n)
        .map(([k, kb]) => `${k} ${kb >= 0 ? '+' : ''}${kb.toFixed(0)} kB`);
    const row = { game: name };

    // The home screen first (its heap is what going back should return to), then the link's replay.
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('[data-mode=pvc]', { state: 'visible' });
    const later = await page.waitForSelector('.menu-ov [data-act=later]', { state: 'visible', timeout: 3000 }).catch(() => null);
    if (later) await later.click().catch(() => {});
    await page.waitForTimeout(1500);
    row.home = await heapMB();
    const homeKinds = await heapKinds();
    const openReplay = async () => {
      await page.evaluate((l) => (location.hash = '#game=' + l), link);
      await page.waitForSelector('[data-act=review]', { timeout: 30000 });
    };
    await openReplay();
    await page.waitForTimeout(1500);
    const before = await heapMB();
    row.replay = before;

    // The first open: the review runs. Count the redraws (each sets the progress line) and the long tasks.
    await page.evaluate(() => {
      window.__draws = 0;
      window.__long = [];
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: 'longtask', buffered: false });
      const watch = () => {
        const p = document.querySelector('.rvprog span');
        if (!p) return requestAnimationFrame(watch);
        new MutationObserver(() => window.__draws++).observe(p, { childList: true, characterData: true, subtree: true });
      };
      watch();
      window.__t0 = performance.now();
    });
    // Traced: where the main thread's time goes while it runs (self time per event, as screens.mjs does).
    await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'toplevel', 'blink', 'v8', 'cc'] });
    const m0 = await metrics();
    const t0 = Date.now();
    await page.click('[data-act=review]');
    await page.waitForFunction(() => /moves reviewed/.test(document.querySelector('.rvprog span')?.textContent ?? ''), null, { timeout: 30 * 60 * 1000, polling: 1000 });
    const runS = (Date.now() - t0) / 1000;
    const m1 = await metrics();
    const trace = JSON.parse((await browser.stopTracing()).toString('utf8'));
    const ev = trace.traceEvents ?? trace;
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
    const busiest = [...self].filter(([n]) => n !== 'RunTask' && n !== 'ThreadControllerImpl::RunTask').sort((x, y) => y[1] - x[1]).slice(0, 8).map(([n, us]) => `${n} ${(us / 1000 / runS).toFixed(0)}`);
    const frames = ev.filter((e) => e.name === 'DrawFrame').length;
    const run = await page.evaluate(() => ({ draws: window.__draws, long: window.__long.length, longMax: Math.round(Math.max(0, ...window.__long)), longSum: Math.round(window.__long.reduce((a, b) => a + b, 0)) }));
    const d = (k) => 1000 * (m1[k] - m0[k]);
    row.running = {
      seconds: +runS.toFixed(1),
      draws: run.draws,
      taskMs: Math.round(d('TaskDuration')),
      scriptMs: Math.round(d('ScriptDuration')),
      styleMs: Math.round(d('RecalcStyleDuration')),
      layoutMs: Math.round(d('LayoutDuration')),
      taskMsPerS: +(d('TaskDuration') / runS).toFixed(1),
      taskMsPerDraw: run.draws ? +(d('TaskDuration') / run.draws).toFixed(1) : null,
      longTasks: run.long,
      longMaxMs: run.longMax,
      longSumMs: run.longSum,
      framesPerS: +(frames / runS).toFixed(1),
      busiest: busiest.join(', '),
    };

    // Finished: the DOM and the heap, then 5 s idle.
    await page.waitForTimeout(1500);
    row.finished = { ...(await heapMB()), ...(await parts()) };
    row.finished.heapOverReplayMB = +(row.finished.heapMB - before.heapMB).toFixed(2);
    const i0 = await metrics();
    await page.waitForTimeout(5000);
    const i1 = await metrics();
    row.finished.idleTaskMsPerS = +((1000 * (i1.TaskDuration - i0.TaskDuration)) / 5).toFixed(1);

    // The taps.
    row.taps = {};
    row.taps.more = await tap('[data-act=more]');
    row.expanded = { ...(await parts()) };
    const chip = await page.evaluate(() => [...document.querySelectorAll('.rvchips [data-filter]')].find((b) => /\d/.test(b.textContent) && !/^\D*0$/.test(b.textContent) && b.dataset.filter !== 'best')?.dataset.filter ?? 'good');
    row.taps.filter = await tap(`.rvchips [data-filter=${chip}]`);
    row.filtered = { label: chip, ...(await parts()) };
    row.taps.unfilter = await tap(`.rvchips [data-filter=${chip}]`);
    row.taps.accuracyTab = await tap('[data-gtab=accuracy]');
    row.taps.luckTab = await tap('[data-gtab=luck]');
    row.taps.winTab = await tap('[data-gtab=win]');
    // The other side's review (a bot's: it runs when picked); the tap only, then back to the person's.
    row.taps.otherSide = await tap('.rvpov .rvp:not(.on)');
    await page.waitForTimeout(500);
    row.taps.ownSide = await tap('.rvpov .rvp[data-pov="0"]');
    await page.waitForTimeout(1500);

    // Back (a link's review goes back home), and what stays: the heap over the home screen's, after a GC.
    await page.click('[data-act=back]');
    await page.waitForSelector('[data-mode=pvc]', { state: 'visible', timeout: 30000 });
    await page.waitForTimeout(1500);
    row.afterBack = await heapMB();
    row.afterBack.heapOverHomeMB = +(row.afterBack.heapMB - row.home.heapMB).toFixed(2);
    const backKinds = await heapKinds();
    row.afterBack.byType = grew(homeKinds.byType, backKinds.byType, 8).join(', ');
    row.afterBack.byName = grew(homeKinds.byName, backKinds.byName, 14).join(', ');
    // Reopen: the link's replay again, then the review (the queue has it).
    await openReplay();
    await page.waitForTimeout(1500);
    row.reopen = await page.evaluate(
      () =>
        new Promise((res) => {
          const t = performance.now();
          let first = null;
          document.querySelector('[data-act=review]').click();
          const look = () => {
            const s = document.querySelector('.rvprog span')?.textContent ?? '';
            if (first === null && document.querySelector('.screen.review .rvcard')) first = performance.now() - t;
            if (/moves reviewed/.test(s)) {
              requestAnimationFrame(() => res({ firstDrawMs: +first.toFixed(1), finishedMs: +(performance.now() - t).toFixed(1) }));
              return;
            }
            if (performance.now() - t > 60000) return res({ firstDrawMs: first, finishedMs: null });
            requestAnimationFrame(look);
          };
          look();
        }),
    );
    out.push(row);
    console.log('REVIEW ' + JSON.stringify(row));
    await context.close();
    } catch (e) {
      console.log(`REVIEW ${name} FAILED: ${e?.stack ?? e}`);
      process.exitCode = 1;
    }
  }
} finally {
  await browser.close();
}

writeFileSync(outFile, JSON.stringify({ label, throttle, rows: out }, null, 2));
md(`### The review screen (#98 target 3)${label ? `, ${label}` : ""}: headless Chrome, 390×844, CPU throttled ${throttle}×`);
md('');
md('**While the review runs** (the main thread; the review itself is in the workers):');
md('');
md('| game | run | redraws | main-thread task | of which script / style / layout | per redraw | per second | long tasks (max, total) |');
md('|---|---:|---:|---:|---:|---:|---:|---:|');
for (const r of out) {
  const x = r.running;
  md(`| ${r.game} | ${x.seconds} s | ${x.draws} | ${x.taskMs} ms | ${x.scriptMs} / ${x.styleMs} / ${x.layoutMs} ms | ${x.taskMsPerDraw} ms | ${x.taskMsPerS} ms/s | ${x.longTasks} (${x.longMaxMs} ms, ${x.longSumMs} ms) |`);
}
md('');
md('**Finished** (after a GC; elements per part of the screen; heap against the replay before it):');
md('');
md('| game | DOM nodes | screen elements | card | graph | key moments (rows) | strip (cells) | after "Show N more": list (rows) | filtered list (rows) | JS heap | over the replay | idle task | home after back, over home before |');
md('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const r of out) {
  const f = r.finished;
  md(`| ${r.game} | ${f.nodes} | ${f.screen} | ${f.card} | ${f.graph} | ${f.list} (${f.rows}) | ${f.strip} (${f.cells}) | ${r.expanded.list} (${r.expanded.rows}) | ${r.filtered.list} (${r.filtered.rows}, ${r.filtered.label}) | ${f.heapMB} MB | +${f.heapOverReplayMB} MB | ${f.idleTaskMsPerS} ms/s | +${r.afterBack.heapOverHomeMB} MB |`);
}
md('');
md('For comparison (after a GC): ' + out.map((r) => `${r.game}: home ${r.home.nodes} nodes, ${r.home.heapMB} MB; the replay ${r.replay.nodes} nodes, ${r.replay.heapMB} MB`).join('; ') + '.');
md('');
md('**Where the main thread goes while the review runs** (self time per event, ms/s; frames drawn per second):');
md('');
md('| game | frames/s | busiest |');
md('|---|---:|---|');
for (const r of out) md(`| ${r.game} | ${r.running.framesPerS} | ${r.running.busiest} |`);
md('');
md('**What stays after Back** (heap snapshot at home after the review against home before it; by kind, then the biggest):');
md('');
md('| game | by kind | biggest |');
md('|---|---|---|');
for (const r of out) md(`| ${r.game} | ${r.afterBack.byType} | ${r.afterBack.byName} |`);
md('');
md('**Taps and opening** (to the next frame):');
md('');
md('| game | Show N more | filter | unfilter | Accuracy tab | Luck tab | Win % tab | other side | own side | reopen: first draw | reopen: finished |');
md('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const r of out) {
  const t = r.taps;
  md(`| ${r.game} | ${t.more ?? '–'} ms | ${t.filter} ms | ${t.unfilter} ms | ${t.accuracyTab} ms | ${t.luckTab} ms | ${t.winTab} ms | ${t.otherSide} ms | ${t.ownSide} ms | ${r.reopen.firstDrawMs} ms | ${r.reopen.finishedMs} ms |`);
}
md('');
