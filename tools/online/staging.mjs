// PvP custom against a room server (#204, #215): two players, each a browser context on the game's dev build
// (http://localhost:5173: the staging server's ALLOWED_ORIGINS accepts it), play one test: a mode to the end, or
// reload + rejoin, Leave game, a 60 s disconnect, three timeouts in a row. Each player accepts the first-launch
// terms (#208) and must not be asked again at connect time.
//   node tools/online/staging.mjs <test> [chrome path] [--url http://localhost:5173/] [--out staging-out]
//   tests: mode:<ffa|1v1|duo|2v2> | modes (all four) | rejoin | leave | disconnect | timeouts
// .github/workflows/pvp-staging.yml runs each test as its own job, with the dev server pointed at the server by
// VITE_ROOMS_URL. Writes <out>/<test>.json (pass or fail and the details), screenshots, and a summary line.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const flag = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const pos = args.filter((x, i) => !x.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [test = 'modes', exe] = pos;
const URL = flag('url', 'http://localhost:5173/');
const OUT = flag('out', 'staging-out');
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const results = [];
const summary = process.env.GITHUB_STEP_SUMMARY;

async function player(name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(name, 'PAGEERROR', String(e).slice(0, 200)));
  await page.goto(URL, { waitUntil: 'load' });
  await home(page);
  return { name, ctx, page, termsAtConnect: false };
}
async function home(page) {
  await page.locator('[data-mode=pvc]').waitFor({ timeout: 30000 });
  // First launch: the terms (#208), accepted once.
  const t = page.locator('.terms-ov [data-act=accept]');
  if (await t.isVisible({ timeout: 2500 }).catch(() => false)) await t.click();
  await page.locator('.menu-ov [data-act=later]').click({ timeout: 2000 }).catch(() => {});
}
const tap = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; e.click(); return true; }, sel);
async function openRooms(p, act = 'room') {
  await tap(p.page, '[data-mode=pvp]');
  await p.page.locator(`.friends-ov [data-act=${act}]`).waitFor({ timeout: 10000 });
  await tap(p.page, `.friends-ov [data-act=${act}]`);
}
async function sawTerms(p) {
  if (await p.page.locator('.terms-ov').isVisible({ timeout: 1500 }).catch(() => false)) {
    p.termsAtConnect = true;
    await tap(p.page, '.terms-ov [data-act=accept]');
  }
}
async function create(p, mode, pairing = 'opposite') {
  await openRooms(p);
  await p.page.locator('.namein').fill(p.name);
  await tap(p.page, '[data-act=to-create]');
  await tap(p.page, `[data-k=mode] [data-v="${mode}"]`);
  if (mode === 'duo') await tap(p.page, `[data-k=pairing] [data-v=${pairing}]`);
  await tap(p.page, '[data-act=create]');
  await sawTerms(p);
  await p.page.waitForFunction(() => /^[A-Z0-9]{5}$/.test(document.querySelector('.wiz[data-step=lobby] .code')?.textContent?.trim() ?? ''), null, { timeout: 30000 });
  return (await p.page.textContent('.wiz[data-step=lobby] .code')).trim();
}
async function join(p, code) {
  await openRooms(p);
  await p.page.locator('.namein').fill(p.name);
  await tap(p.page, '[data-act=to-join]');
  await p.page.locator('.codein').fill(code);
  await tap(p.page, '[data-act=join]');
  await sawTerms(p);
  await p.page.waitForFunction((c) => document.querySelector('.wiz[data-step=lobby] .code')?.textContent?.trim() === c, code, { timeout: 30000 });
}
async function start(host, guest) {
  await host.page.waitForFunction(() => !document.querySelector('[data-act=start]')?.disabled, null, { timeout: 30000 });
  await tap(host.page, '[data-act=start]');
  for (const p of [host, guest]) await p.page.locator('.screen.game').waitFor({ timeout: 30000 });
  log('game started');
}
/** One step of play, if it's this player's: the result, a cutscene, a crowded choice, a marker, or the roll. */
async function step(p) {
  const r = await p.page.evaluate(() => {
    if (document.querySelector('.result')) return 'over';
    const cs = document.querySelector('.cs');
    if (cs) { cs.click(); return 'cs'; }
    const ch = document.querySelector('.choice');
    if (ch) { ch.click(); return 'move'; }
    const mk = document.querySelector('.mark');
    if (mk) { const b = mk.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }
    const rb = document.querySelector('[data-act=roll]');
    if (rb && !rb.hidden && !rb.disabled) { rb.click(); return 'roll'; }
    return 'wait';
  }).catch(() => 'gone');
  if (r && typeof r === 'object') {
    await p.page.mouse.click(r.x, r.y);
    return 'move';
  }
  return r;
}
/** Plays everyone in `players` (each skipped while paused) until each sees the result, or `until` says stop. */
async function play(players, { maxMs = 30 * 60000, until = null, paused = new Set() } = {}) {
  const t0 = Date.now();
  const done = new Set();
  let steps = 0;
  while (Date.now() - t0 < maxMs) {
    for (const p of players) {
      if (done.has(p) || paused.has(p)) continue;
      const r = await step(p);
      if (r === 'over') { done.add(p); log(p.name, 'sees the result'); }
      else if (r !== 'wait') steps++;
    }
    if (players.every((p) => done.has(p) || paused.has(p)) && done.size) break;
    if (until && (await until(steps))) return { steps, stopped: true, ms: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { steps, stopped: false, ms: Date.now() - t0, over: [...done].map((p) => p.name) };
}
const result = (p) => p.page.evaluate(() => { const r = document.querySelector('.result'); return r ? `${r.classList.contains('won') ? 'WON' : 'not won'}: ${(r.querySelector('h1,h2')?.textContent ?? '').trim()}` : 'no result'; });
const pair = async (mode, pairing) => {
  const host = await player('Host');
  const guest = await player('Guest');
  const code = await create(host, mode, pairing);
  log(`${mode}: room ${code}`);
  await join(guest, code);
  await start(host, guest);
  return { host, guest, code };
};
const close = async (...ps) => { for (const p of ps) await p.ctx.close().catch(() => {}); };
const report = (name, pass, detail) => {
  log(`RESULT ${name}: ${pass ? 'PASS' : 'FAIL'} — ${detail}`);
  results.push({ name, pass, detail });
  if (summary) appendFileSync(summary, `| ${name} | ${pass ? 'PASS' : '**FAIL**'} | ${detail.replaceAll('|', '/')} |\n`);
};
/** The test's name as a file name. */
const slug = test.replace(/\W+/g, '-');
/** Screenshots of both phones (whatever they show now). */
const shots = async (label, ...ps) => {
  for (const p of ps) await p.page.screenshot({ path: `${OUT}/${slug}-${label}-${p.name}.png` }).catch(() => {});
};

try {
  if (test === 'modes' || test.startsWith('mode:')) {
    const modes = test === 'modes' ? [['ffa'], ['1v1'], ['duo', 'opposite'], ['2v2']] : [[test.slice(5)]];
    for (const [mode, pairing] of modes) {
      const { host, guest } = await pair(mode, pairing);
      const r = await play([host, guest]);
      const hr = await result(host), gr = await result(guest);
      await shots(`${mode}-end`, host, guest);
      report(`mode ${mode}`, r.over?.length === 2, `${r.steps} steps in ${Math.round(r.ms / 1000)} s; host ${hr}; guest ${gr}; terms asked at connect: ${host.termsAtConnect || guest.termsAtConnect}`);
      await close(host, guest);
    }
  } else if (test === 'rejoin') {
    const { host, guest } = await pair('1v1');
    await play([host, guest], { until: (n) => n >= 40 });
    log('guest reloads mid-game');
    await guest.page.reload({ waitUntil: 'load' });
    await home(guest.page);
    const back = await guest.page.evaluate(() => { document.querySelector('[data-mode=pvp]')?.click(); return new Promise((r) => setTimeout(() => r(document.querySelector('.friends-ov [data-act=rejoin]')?.textContent ?? ''), 800)); });
    await tap(guest.page, '.friends-ov [data-act=rejoin]');
    await sawTerms(guest);
    const ok = await guest.page.locator('.screen.game').waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
    log(`rejoin offered: "${back.trim()}"; back in the game: ${ok}`);
    const r = await play([host, guest]);
    await shots('end', host, guest);
    report('reload mid-game + rejoin', ok && r.over?.length === 2, `offered "${back.trim()}", rejoined ${ok}, then ${r.steps} steps to the end; host ${await result(host)}; guest ${await result(guest)}`);
    await close(host, guest);
  } else if (test === 'leave') {
    const { host, guest } = await pair('1v1');
    await play([host, guest], { until: (n) => n >= 20 });
    log('guest leaves');
    await tap(guest.page, '[data-act=menu]');
    await guest.page.locator('.menu-ov [data-act=quit]').waitFor({ timeout: 5000 });
    await tap(guest.page, '.menu-ov [data-act=quit]');
    const warn = await guest.page.evaluate(() => document.querySelector('.menu-ov .sub.warn')?.textContent ?? '');
    await tap(guest.page, '.menu-ov [data-act=quit]');
    const t = Date.now();
    const r = await play([host], { maxMs: 60000 });
    const hr = await result(host);
    await shots('end', host, guest);
    report('Leave game forfeits (1v1)', r.over?.length === 1 && hr.startsWith('WON'), `the warning: "${warn}"; host sees ${hr} after ${Math.round((Date.now() - t) / 1000)} s`);
    await close(host, guest);
  } else if (test === 'disconnect') {
    const { host, guest } = await pair('1v1');
    await play([host, guest], { until: (n) => n >= 20 });
    log('guest drops (its browser closes)');
    await guest.ctx.close();
    const t = Date.now();
    const r = await play([host], { maxMs: 150000 });
    const s = Math.round((Date.now() - t) / 1000);
    const hr = await result(host);
    await shots('end', host);
    report('60 s disconnect forfeits (1v1)', r.over?.length === 1 && hr.startsWith('WON') && s >= 50, `host sees ${hr} after ${s} s`);
    await close(host);
  } else if (test === 'timeouts') {
    const { host, guest } = await pair('1v1');
    await play([host, guest], { until: (n) => n >= 20 });
    log('guest stops playing (stays connected)');
    const t = Date.now();
    const r = await play([host, guest], { maxMs: 300000, paused: new Set([guest]) });
    const s = Math.round((Date.now() - t) / 1000);
    const hr = await result(host);
    const gr = await result(guest);
    await shots('end', host, guest);
    report('3 timeouts in a row forfeit (1v1)', hr.startsWith('WON'), `host sees ${hr} after ${s} s; guest ${gr}`);
    await close(host, guest);
  }
} catch (e) {
  log('ERROR', e?.stack ?? e);
  report(test, false, `error: ${String(e?.message ?? e).split(String.fromCharCode(10))[0]}`);
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/${slug}.json`, JSON.stringify(results, null, 2));
if (!results.length || results.some((r) => !r.pass)) process.exitCode = 1;
