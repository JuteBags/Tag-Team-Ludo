import { chromium } from 'file:///S:/tools/lemo-opuscar/node_modules/playwright-core/index.mjs';
const [html, out] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 940, height: 2900 }, deviceScaleFactor: 1 });
await p.goto('file:///' + html.replace(/^\/c\//, 'C:/'));
await p.waitForTimeout(800);
await p.screenshot({ path: out, fullPage: true });
await b.close();
