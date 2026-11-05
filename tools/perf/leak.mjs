// What keeps a left screen alive (#201). In a production build in headless Chrome, a path through the app ends
// back on the home screen; after a GC, the DOM node count against the home screen's before it, and a heap
// snapshot: every detached element by name, and for a few of them the shortest chain of references from the GC
// roots (what retains it).
//   node tools/perf/leak.mjs <url> [chrome path]
// .github/workflows/perf-screens.yml runs it (the "perf leak" job).
import { appendFileSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [url, executablePath] = process.argv.slice(2);
const summary = process.env.GITHUB_STEP_SUMMARY;
const md = (line) => {
  console.log(line);
  if (summary) appendFileSync(summary, line + '\n');
};
const link = readFileSync(new URL('./game-seed24.link.txt', import.meta.url), 'utf8').trim();

const browser = await chromium.launch(executablePath ? { executablePath } : {});
const rows = [];
try {
  for (const path of ['replay, Back', 'replay, Review, Back']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const nodes = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      await page.waitForTimeout(300);
      await cdp.send('HeapProfiler.collectGarbage');
      return (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'Nodes').value;
    };
    const home = async () => {
      await page.waitForSelector('[data-mode=pvc]', { state: 'visible', timeout: 30000 });
      const later = await page.waitForSelector('.menu-ov [data-act=later]', { state: 'visible', timeout: 2500 }).catch(() => null);
      if (later) await later.click().catch(() => {});
      await page.waitForTimeout(1500);
    };
    await page.goto(url, { waitUntil: 'load' });
    await home();
    const before = await nodes();
    await page.evaluate((l) => (location.hash = '#game=' + l), link);
    await page.waitForSelector('[data-act=review]', { timeout: 30000 });
    await page.waitForTimeout(1000);
    if (path.includes('Review')) {
      await page.click('[data-act=review]');
      await page.waitForFunction(() => /moves reviewed/.test(document.querySelector('.rvprog span')?.textContent ?? ''), null, { timeout: 15 * 60 * 1000, polling: 500 });
      await page.waitForTimeout(500);
    }
    await page.click('[data-act=back]');
    await home();
    const after = await nodes();

    // The heap snapshot: detached elements, and the shortest strong path from the root to a few of them.
    const chunks = [];
    const onChunk = (c) => chunks.push(c.chunk);
    cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false });
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
    const snap = JSON.parse(chunks.join(''));
    const m = snap.snapshot.meta;
    const NF = m.node_fields.length;
    const EF = m.edge_fields.length;
    const [nType, nName, nEdges, nDet] = ['type', 'name', 'edge_count', 'detachedness'].map((k) => m.node_fields.indexOf(k));
    const [eType, eName, eTo] = ['type', 'name_or_index', 'to_node'].map((k) => m.edge_fields.indexOf(k));
    const nodeTypes = m.node_types[0];
    const edgeTypes = m.edge_types[0];
    const N = snap.nodes.length / NF;
    const firstEdge = new Uint32Array(N + 1);
    for (let i = 0, e = 0; i < N; i++) {
      firstEdge[i] = e;
      e += snap.nodes[i * NF + nEdges] * EF;
      firstEdge[i + 1] = e;
    }
    const name = (i) => String(snap.strings[snap.nodes[i * NF + nName]]);
    const type = (i) => nodeTypes[snap.nodes[i * NF + nType]];
    const edgeName = (e) => {
      const t = edgeTypes[snap.edges[e + eType]];
      const v = snap.edges[e + eName];
      return t === 'element' || t === 'hidden' ? `[${v}]` : String(snap.strings[v]);
    };
    // Detached elements by name.
    const detached = new Map();
    const examples = [];
    for (let i = 0; i < N; i++) {
      if (nDet < 0 || snap.nodes[i * NF + nDet] !== 2) continue;
      const nm = name(i);
      if (!/^(Detached )?(HTML|SVG)\w*Element/.test(nm) && !/Element$/.test(nm)) continue;
      detached.set(nm, (detached.get(nm) ?? 0) + 1);
      if (/SVGRectElement|HTMLDivElement/.test(nm) && examples.length < 400) examples.push(i);
    }
    // BFS from the root (node 0) over strong edges: the parent of each node on its shortest path.
    const parent = new Int32Array(N).fill(-1);
    const via = new Int32Array(N).fill(-1);
    parent[0] = 0;
    const queue = [0];
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h];
      for (let e = firstEdge[i]; e < firstEdge[i + 1]; e += EF) {
        const t = edgeTypes[snap.edges[e + eType]];
        if (t === 'weak' || t === 'shortcut') continue;
        const j = snap.edges[e + eTo] / NF;
        if (parent[j] !== -1) continue;
        parent[j] = i;
        via[j] = e;
        queue.push(j);
      }
    }
    const paths = new Map();
    for (const i of examples) {
      if (parent[i] === -1) continue;
      const steps = [];
      for (let k = i, n = 0; k !== 0 && n < 40; k = parent[k], n++) steps.push(`${type(parent[k])}:${name(parent[k]).slice(0, 50)} -${edgeName(via[k])}->`);
      const p = steps.reverse().join(' ') + ` ${name(i)}`;
      // The same chain up to the element itself: keep one of each.
      const key = steps.slice(0, -3).join(' ');
      if (!paths.has(key)) paths.set(key, p);
      if (paths.size >= 4) break;
    }
    rows.push({ path, before, after, detached: [...detached].sort((a, b) => b[1] - a[1]).slice(0, 8), paths: [...paths.values()] });
    console.log('LEAK ' + JSON.stringify(rows.at(-1)));
    await context.close();
  }
} finally {
  await browser.close();
}

md('### What keeps a left screen alive (#201)');
md('');
md('| path (from home, back to home) | DOM nodes before / after (GC) | detached elements |');
md('|---|---:|---|');
for (const r of rows) md(`| ${r.path} | ${r.before} / ${r.after} | ${r.detached.map(([n, c]) => `${n} ${c}`).join(', ') || 'none'} |`);
md('');
for (const r of rows) {
  md(`**${r.path}:** the shortest retaining paths from the GC roots`);
  md('');
  for (const p of r.paths) md(`- \`${p.replace(/`/g, "'")}\``);
  if (!r.paths.length) md('- none found');
  md('');
}
