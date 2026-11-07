// The review screen's frames, to show that a perf: change looks the same (#98 target 3). On a build, for each game
// link: the review screen's HTML after every redraw, from the first draw through the running review to the end,
// then through the taps (Show N more, the graph's tabs, a count's filter, the rival's side and back), and
// screenshots of the whole scrolled screen, 360 dp wide, at the running state (held still) and at each finished
// state. The review runs on one worker (one CPU core reported), so the verdicts land in the same order on every
// build.
//   node tools/perf/review-frames.mjs <url> <out dir> [chrome path]       writes <out dir>/frames.json and PNGs
//   node tools/perf/review-frames.mjs --compare <base dir> <head dir>      the two builds' frames, side by side
// Before comparing, each snapshot leaves out what isn't drawn or changes with the clock: the die faces and core
// plates the rest angle turns away (backface-hidden), and the time left. .github/workflows/perf-screens.yml
// runs it on main and on the PR.
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const summary = process.env.GITHUB_STEP_SUMMARY;
const md = (line) => {
  console.log(line);
  if (summary) appendFileSync(summary, line + '\n');
};
const games = [
  ['2p', 'game-seed24.link.txt'],
  ['4p', 'game-4p-seed24.link.txt'],
  ['4p, Easy person', 'game-4p-easy-seed24.link.txt'],
];

/** An 8-bit RGB(A), non-interlaced PNG's pixels (what Chrome's screenshots are). */
function decode(path) {
  const b = readFileSync(path);
  let p = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8), data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * bpp);
  const stride = w * bpp;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const up = y ? out[(y - 1) * stride + x] : 0;
      const c = y && x >= bpp ? out[(y - 1) * stride + x - bpp] : 0;
      let r = v;
      if (f === 1) r = v + a; else if (f === 2) r = v + up; else if (f === 3) r = v + ((a + up) >> 1);
      else if (f === 4) { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c); }
      out[y * stride + x] = r & 255;
    }
  }
  return { w, h, bpp, px: out };
}

/**
 * The largest difference in any colour channel (0-255) between two screenshots of the same size. Up to SAME_WITHIN
 * counts as the same: a layer composited on the GPU (will-change) can round a blend by a few levels, which no one
 * can see (#98: the bar's scaleX). Anything bigger, or a different size, is a real difference.
 */
const SAME_WITHIN = 8;
function maxDiff(a, b) {
  const x = decode(a);
  const y = decode(b);
  if (x.w !== y.w || x.h !== y.h) return 255;
  let m = 0;
  for (let i = 0; i < x.w * x.h; i++) for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(x.px[i * x.bpp + k] - y.px[i * y.bpp + k]));
  return m;
}

if (args[0] === '--compare') {
  const [, baseDir, headDir] = args;
  const base = JSON.parse(readFileSync(join(baseDir, 'frames.json'), 'utf8'));
  const head = JSON.parse(readFileSync(join(headDir, 'frames.json'), 'utf8'));
  let bad = 0;
  md('### The review screen\'s frames: main against this branch (#98 target 3)');
  md('');
  md('| game | redraw snapshots (main / branch) | the same | screenshots (main / branch) | pixel-identical |');
  md('|---|---:|---|---:|---|');
  for (const [name] of games) {
    const b = base.games[name];
    const h = head.games[name];
    if (!b || !h) {
      md(`| ${name} | missing | – | – | – |`);
      bad++;
      continue;
    }
    let firstDiff = -1;
    for (let i = 0; i < Math.max(b.snapshots.length, h.snapshots.length); i++)
      if (b.snapshots[i] !== h.snapshots[i]) {
        firstDiff = i;
        break;
      }
    const shots = Object.keys(b.shots);
    // A screenshot's file, from its key ("<label> <page>").
    const file = (dir, key) => join(dir, `${name.replace(/\W+/g, '-')}-${key.slice(0, key.lastIndexOf(' ')).replace(/\W+/g, '-')}-${key.slice(key.lastIndexOf(' ') + 1)}.png`);
    const near = [];
    const diffShots = shots
      .filter((k) => {
        if (b.shots[k] === h.shots[k]) return false;
        const d = k in h.shots ? maxDiff(file(baseDir, k), file(headDir, k)) : 255;
        if (d <= SAME_WITHIN) near.push(`${k} (${d}/255)`);
        return d > SAME_WITHIN;
      })
      .concat(Object.keys(h.shots).filter((k) => !(k in b.shots)));
    if (near.length) console.log(`${name}: the same within ${SAME_WITHIN}/255: ${near.join(', ')}`);
    if (firstDiff >= 0 || diffShots.length) bad++;
    md(`| ${name} | ${b.snapshots.length} / ${h.snapshots.length} | ${firstDiff < 0 ? 'yes' : `no: first at snapshot ${firstDiff}`} | ${shots.length} / ${Object.keys(h.shots).length} | ${diffShots.length ? `no: ${diffShots.join(', ')}` : near.length ? `yes (${near.length} within ${SAME_WITHIN}/255)` : 'yes'} |`);
    if (firstDiff >= 0) {
      const x = b.snapshots[firstDiff] ?? '';
      const y = h.snapshots[firstDiff] ?? '';
      let k = 0;
      while (k < x.length && x[k] === y[k]) k++;
      console.log(`${name}, snapshot ${firstDiff}, from character ${k}:\n main:   ${x.slice(Math.max(0, k - 200), k + 300)}\n branch: ${y.slice(Math.max(0, k - 200), k + 300)}`);
    }
  }
  md('');
  md(bad ? '**The frames differ** (the first difference is in the log).' : 'Every redraw\'s DOM and every screenshot are the same on both builds.');
  process.exit(bad ? 1 : 0);
}

const { chromium } = await import('playwright-core');
const [url, outDir, executablePath] = args;
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const result = { games: {} };
try {
  for (const [name, file] of games) {
    const link = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').trim();
    const context = await browser.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2 });
    await context.addInitScript(() => Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 1 }));
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('[data-mode=pvc]', { state: 'visible' });
    const later = await page.waitForSelector('.menu-ov [data-act=later]', { state: 'visible', timeout: 3000 }).catch(() => null);
    if (later) await later.click().catch(() => {});
    await page.evaluate((l) => (location.hash = '#game=' + l), link);
    await page.waitForSelector('[data-act=review]', { timeout: 30000 });
    // Every redraw's HTML, from the first draw on (a mutation batch is one task: one redraw).
    await page.evaluate(() => {
      const w = window;
      w.__snaps = [];
      const snap = () => {
        const s = document.querySelector('.screen.review');
        if (!s) return;
        const c = s.cloneNode(true);
        // Drawn nowhere at rest: the faces and core plates turned away from the viewer (backface-hidden).
        c.querySelectorAll('.die3 > .f.bk, .die3 > .f.lf, .die3 > .f.bt').forEach((e) => e.remove());
        c.querySelectorAll('.die3 > .c').forEach((e) => {
          if (/rotateY\(180deg\)|rotateY\(-90deg\)|rotateX\(-90deg\)/.test(e.getAttribute('style') ?? '')) e.remove();
        });
        // The progress bar's fill: a width on one build, a scaleX on the other (#98); its pixels are in the screenshots.
        c.querySelectorAll('.rvprog .bar i').forEach((e) => e.removeAttribute('style'));
        // The time left changes with the clock.
        const p = c.querySelector('.rvprog span');
        if (p) p.textContent = (p.textContent ?? '').replace(/ · (Almost done|About [^·]* left)$/, '');
        const html = c.outerHTML;
        if (w.__snaps.at(-1) !== html) w.__snaps.push(html);
      };
      w.__snap = snap;
      new MutationObserver(snap).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    });
    const finished = () => page.waitForFunction(() => /moves reviewed/.test(document.querySelector('.rvprog span')?.textContent ?? ''), null, { timeout: 30 * 60 * 1000, polling: 500 });
    /** Waits until the screen has stopped changing for `ms`. */
    const quiet = async (ms = 1200) => {
      for (let n = 0; n < 200; n++) {
        const a = await page.evaluate(() => window.__snaps.length);
        await page.waitForTimeout(ms);
        if ((await page.evaluate(() => window.__snaps.length)) === a) return;
      }
    };
    const shots = {};
    /** The whole screen, scrolled a page at a time. */
    const shoot = async (label) => {
      const h = await page.evaluate(() => {
        const b = document.querySelector('.rvbody');
        return { total: b.scrollHeight, page: b.clientHeight };
      });
      for (let y = 0, k = 0; y < h.total; y += h.page, k++) {
        await page.evaluate((top) => (document.querySelector('.rvbody').scrollTop = top), y);
        await page.waitForTimeout(250);
        const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
        const key = `${label} ${k}`;
        shots[key] = createHash('sha256').update(png).digest('hex');
        writeFileSync(join(outDir, `${name.replace(/\W+/g, '-')}-${label.replace(/\W+/g, '-')}-${k}.png`), png);
      }
      await page.evaluate(() => (document.querySelector('.rvbody').scrollTop = 0));
      await page.waitForTimeout(250);
    };
    const tap = async (sel) => {
      const ok = await page.evaluate((s) => {
        const e = document.querySelector(s);
        if (!e) return false;
        e.click();
        return true;
      }, sel);
      await quiet();
      return ok;
    };

    // The running state, held still: the engine's module isn't served until it's been shot, so the screen
    // shows the review started and nothing checked yet.
    let release = () => {};
    const gate = new Promise((r) => (release = r));
    let held = 0;
    await context.route(/ludo_wasm[^/]*\.wasm(\?|$)/, async (route) => {
      held++;
      await gate;
      await route.continue();
    });
    await page.click('[data-act=review]');
    await page.waitForTimeout(3000);
    if (held) await shoot('running');
    // The progress bar at 40% and 100% (#98: a width transition or a scaleX one, whichever this build has), as
    // a crop of the progress row: for the before/after look, not compared byte for byte.
    if (held && name === '2p')
      for (const f of [0.4, 1]) {
        await page.evaluate((x) => {
          const i = document.querySelector('.rvprog .bar i');
          if (getComputedStyle(i).transitionProperty.includes('transform')) i.style.transform = `scaleX(${x})`;
          else i.style.width = `${100 * x}%`;
        }, f);
        await page.waitForTimeout(600);
        const box = await page.$('.rvprog');
        if (box) writeFileSync(join(outDir, `bar-${Math.round(100 * f)}.png`), await box.screenshot({ animations: 'disabled' }));
      }
    else console.log(`${name}: the engine module wasn't held (already loaded): no running-state screenshot`);
    release();
    await finished();
    await quiet();
    await shoot('finished');
    if (await tap('[data-act=more]')) await shoot('more');
    for (const t of ['accuracy', 'luck', 'win']) if (await tap(`[data-gtab=${t}]`)) await shoot(`tab ${t}`);
    const chip = await page.evaluate(() => [...document.querySelectorAll('.rvchips [data-filter]')].find((b) => b.dataset.filter !== 'best' && !/^\D*0$/.test(b.textContent ?? ''))?.dataset.filter);
    if (chip && (await tap(`.rvchips [data-filter=${chip}]`))) {
      await shoot(`filter ${chip}`);
      await tap(`.rvchips [data-filter=${chip}]`);
    }
    // The rival's side: it's reviewed when picked (running, then finished), and back.
    if (await tap('.rvpov .rvp:not(.on)')) {
      await finished();
      await quiet();
      await shoot('rival');
      await tap('.rvpov .rvp[data-pov="0"]');
      await shoot('own again');
    }
    const snapshots = await page.evaluate(() => window.__snaps);
    result.games[name] = { snapshots, shots };
    console.log(`${name}: ${snapshots.length} snapshots, ${Object.keys(shots).length} screenshots`);
    await context.close();
  }
} finally {
  await browser.close();
}
writeFileSync(join(outDir, 'frames.json'), JSON.stringify(result));
