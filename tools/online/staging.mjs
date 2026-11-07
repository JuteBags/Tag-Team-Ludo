// PvP custom against a room server (#204, #215): two players, each a browser context on the game's dev build
// (http://localhost:5173: the staging server's ALLOWED_ORIGINS accepts it), play one test: a mode to the end, or
// reload + rejoin, Leave game, a 60 s disconnect, three timeouts in a row. Each player accepts the first-launch
// terms (#208) and must not be asked again at connect time.
//   node tools/online/staging.mjs <test> [chrome path] [--url http://localhost:5173/] [--out staging-out]
//   tests: mode:<ffa|1v1|duo|2v2> | modes (all four) | rejoin | leave | disconnect | timeouts | chat, friends,
//          ranked-pair, ranked-botfill, ranked-nobots, ranked-lower (our server; ranked-* need TEST_HOOKS=1),
//          abuse (our server: floods from one client are cut off while a game plays on, #220),
//          share (our server: a game shared as a short link opens in another browser, #229)
// RESULT_PREFIX (env) is put before each result's name (e.g. "local · ").
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

/** A player. `phone`: a 360 dp phone at 2x (for frames). `decline`: Not now on the first-launch terms. */
async function player(name, { phone = false, decline = false } = {}) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 360, height: 780 }, deviceScaleFactor: 2 } : { viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(name, 'PAGEERROR', String(e).slice(0, 200)));
  await page.goto(URL, { waitUntil: 'load' });
  await home(page, decline);
  return { name, ctx, page, termsAtConnect: false };
}
async function home(page, decline = false) {
  await page.locator('[data-mode=pvc]').waitFor({ timeout: 30000 });
  // First launch: the terms (#208), accepted once (or Not now).
  const t = page.locator(`.terms-ov [data-act=${decline ? 'later' : 'accept'}]`);
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
const report = (name0, pass, detail) => {
  const name = `${process.env.RESULT_PREFIX ?? ''}${name0}`;
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
      // #234: behind the result, nobody's hint is still "Sending…" (the last move was confirmed).
      const pending = await Promise.all([host, guest].map((p) => p.page.evaluate(() => document.querySelector('.hint small')?.textContent ?? '')));
      report(`mode ${mode}: no hint left at "Sending…" at the end`, pending.every((t) => !t.includes('Sending')), `hints: ${JSON.stringify(pending)}`);
      // #237: the result's Share sends the image and the game's link together: the short link on our own server, the
      // long one where the server has no shares (or the upload fails).
      await host.page.evaluate(() => {
        window.__shared = null;
        navigator.canShare = () => true;
        navigator.share = async (d) => { window.__shared = { text: d.text, files: (d.files ?? []).length }; };
      });
      await tap(host.page, '.result [data-act=share]');
      const shared = await host.page.waitForFunction(() => window.__shared, null, { timeout: 20000 }).then((h) => h.jsonValue()).catch(() => null);
      const ours = /localhost|127\.0\.0\.1/.test(process.env.VITE_ROOMS_URL ?? '');
      const link = /play\/#(g=[A-Z0-9]{12}|game=)/.exec(shared?.text ?? '')?.[0] ?? '';
      report(`mode ${mode}: the result's Share sends the image and the game link`, !!shared && shared.files === 1 && (ours ? link.startsWith('play/#g=') : !!link), `files ${shared?.files}; link ${link || 'none'}; text: ${(shared?.text ?? '').slice(0, 90)}`);
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
  } else if (test === 'frames') {
    // The PR's frames (#215), at 360 dp, on a server with chat: With friends, creating a room, joining, the
    // "Play online" terms, the lobby, the game's top bar with chat, the chat sheet, and the result of a forfeit.
    const shot = async (p, label) => {
      await p.page.waitForTimeout(700);
      await p.page.screenshot({ path: `${OUT}/frame-${label}.png` });
      log('frame', label);
    };
    const host = await player('Asha', { phone: true });
    const guest = await player('Leo', { phone: true, decline: true });
    await tap(host.page, '[data-mode=pvp]');
    await host.page.locator('.friends-ov').waitFor();
    await shot(host, '1-with-friends');
    await tap(host.page, '.friends-ov [data-act=room]');
    await host.page.locator('.namein').fill('Asha');
    await tap(host.page, '[data-act=to-create]');
    await tap(host.page, '[data-k=mode] [data-v="1v1"]');
    await shot(host, '2-create-room');
    await tap(host.page, '[data-act=create]');
    await host.page.waitForFunction(() => /^[A-Z0-9]{5}$/.test(document.querySelector('.wiz[data-step=lobby] .code')?.textContent?.trim() ?? ''), null, { timeout: 30000 });
    const code = (await host.page.textContent('.wiz[data-step=lobby] .code')).trim();
    await shot(host, '3-room-created');
    await openRooms(guest);
    await guest.page.locator('.namein').fill('Leo');
    await tap(guest.page, '[data-act=to-join]');
    await guest.page.locator('.codein').fill(code);
    await shot(guest, '4-join');
    await tap(guest.page, '[data-act=join]');
    // Not now at launch: online asks first.
    await guest.page.locator('.terms-ov').waitFor({ timeout: 10000 });
    await shot(guest, '5-play-online-terms');
    await tap(guest.page, '.terms-ov [data-act=accept]');
    await guest.page.waitForFunction((c) => document.querySelector('.wiz[data-step=lobby] .code')?.textContent?.trim() === c, code, { timeout: 30000 });
    await host.page.waitForFunction(() => !document.querySelector('[data-act=start]')?.disabled, null, { timeout: 30000 });
    await shot(host, '6-lobby');
    await start(host, guest);
    await play([host, guest], { until: (n) => n >= 8 });
    await tap(host.page, '.chatbtn');
    await host.page.locator('.sheet.chat').waitFor();
    await tap(host.page, '.sheet.chat [data-quick="0"]');
    await host.page.waitForTimeout(1200);
    await host.page.locator('.sheet.chat .ctext input').fill('good luck, Leo!');
    await host.page.evaluate(() => document.querySelector('.sheet.chat .ctext').requestSubmit());
    await tap(host.page, '.sheet.chat [data-act=close]');
    await guest.page.waitForTimeout(600);
    await shot(guest, '7-game-chat-bubble');
    await tap(guest.page, '.chatbtn');
    await guest.page.locator('.sheet.chat').waitFor();
    await shot(guest, '8-chat-sheet');
    await tap(guest.page, '.sheet.chat [data-act=close]');
    await tap(guest.page, '[data-act=menu]');
    await guest.page.locator('.menu-ov [data-act=quit]').waitFor();
    await tap(guest.page, '.menu-ov [data-act=quit]');
    await shot(guest, '9-leave-warning');
    await tap(guest.page, '.menu-ov [data-act=quit]');
    await play([host], { maxMs: 60000 });
    await shot(host, '10-result-after-forfeit');
    report('frames', true, 'frame-*.png in the artifact');
    await close(host, guest);
  } else if (test === 'friends') {
    // Friends (#209): add by code, see each other online, invite into a private room, join from the invite.
    const host = await player('Asha', { phone: true });
    const guest = await player('Leo', { phone: true });
    const openFriends = async (p) => {
      await openRooms(p);
      await p.page.locator('.namein').fill(p.name);
      await tap(p.page, '[data-act=friends]');
      await p.page.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.querySelector('.sheet.friends .fmine b')?.textContent ?? ''), null, { timeout: 30000 });
      return (await p.page.textContent('.sheet.friends .fmine b')).trim();
    };
    const sees = (p, name) => p.page.waitForFunction((n) => [...document.querySelectorAll('.sheet.friends .frow')].some((r) => r.querySelector('b')?.textContent === n && r.querySelector('.fdot.on')), name, { timeout: 20000 }).then(() => true).catch(() => false);
    const hostCode = await openFriends(host);
    await openFriends(guest);
    await guest.page.locator('.sheet.friends .fadd input').fill(hostCode.toLowerCase());
    await guest.page.evaluate(() => document.querySelector('.sheet.friends .fadd').requestSubmit());
    const guestSees = await sees(guest, 'Asha');
    const hostSees = await sees(host, 'Leo');
    await shots('list', guest);
    await tap(host.page, '.sheet.friends [data-act=close]');
    await tap(guest.page, '.sheet.friends [data-act=close]');
    // The host makes a room and invites Leo from the lobby.
    await tap(host.page, '[data-act=to-create]');
    await tap(host.page, '[data-k=mode] [data-v="1v1"]');
    await tap(host.page, '[data-act=create]');
    await host.page.waitForFunction(() => /^[A-Z0-9]{5}$/.test(document.querySelector('.wiz[data-step=lobby] .code')?.textContent?.trim() ?? ''), null, { timeout: 30000 });
    const room = (await host.page.textContent('.wiz[data-step=lobby] .code')).trim();
    await tap(host.page, '[data-act=invite-friends]');
    await host.page.locator('.sheet.friends .finv').waitFor({ timeout: 20000 });
    await shots('invite-button', host);
    await tap(host.page, '.sheet.friends .finv');
    const gotInvite = await guest.page.locator('.invite-ov').waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
    const inviteText = gotInvite ? await guest.page.textContent('.invite-ov .sub') : '';
    await shots('invite', guest);
    await tap(guest.page, '.invite-ov [data-act=join]');
    const joined = await guest.page.waitForFunction((c) => document.querySelector('.wiz[data-step=lobby] .code')?.textContent?.trim() === c, room, { timeout: 30000 }).then(() => true).catch(() => false);
    const hostHeard = await host.page.waitForFunction(() => document.querySelector('.sheet.friends .finv')?.textContent === 'Joining', null, { timeout: 15000 }).then(() => true).catch(() => false);
    await tap(host.page, '.sheet.friends [data-act=close]');
    const twoInLobby = await host.page.waitForFunction(() => !document.querySelector('[data-act=start]')?.disabled, null, { timeout: 20000 }).then(() => true).catch(() => false);
    await shots('lobby', host, guest);
    report('friends: add by code, online, invite, join', guestSees && hostSees && gotInvite && joined && hostHeard && twoInLobby, `guest sees Asha online ${guestSees}; host sees Leo online ${hostSees}; invite "${(inviteText ?? '').trim()}" ${gotInvite}; guest in room ${room} ${joined}; host heard "Joining" ${hostHeard}; start enabled ${twoInLobby}`);
    await close(host, guest);
  } else if (test.startsWith('ranked')) {
    // Ranked (#216), on our server started with TEST_HOOKS=1 (to put an account at a rating).
    const http = (process.env.VITE_ROOMS_URL ?? 'ws://localhost:8787').replace(/^ws/, 'http');
    const openRanked = async (p) => {
      await p.page.goto(URL, { waitUntil: 'load' });
      await home(p.page);
      await tap(p.page, '[data-act=ranked]');
      await p.page.locator('.rmode[data-mode="1v1"]').waitFor({ timeout: 30000 });
    };
    /** A player whose 1v1 rating is `rating` (20 games: past placement), on the Ranked screen. */
    const ranked = async (name, rating, placementShot = false) => {
      const p = await player(name, { phone: true });
      await openRanked(p);
      // A new account: every mode shows Placement 0/10.
      if (placementShot) await shots('placement', p);
      const key = await p.page.evaluate(() => JSON.parse(localStorage.getItem('ludo-ranked-account') ?? 'null'));
      const res = await fetch(`${http}/api/test/rating`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...key, mode: '1v1', rating, games: 20 }) });
      if (!res.ok) throw new Error(`test hook: HTTP ${res.status} (is TEST_HOOKS on?)`);
      await openRanked(p);
      return p;
    };
    const search = (p) => tap(p.page, '.rmode[data-mode="1v1"]');
    const inGame = (p, ms) => p.page.locator('.screen.game').waitFor({ timeout: ms }).then(() => true).catch(() => false);
    const botText = (p) => p.page.evaluate(() => [...document.querySelectorAll('.pl')].some((pl) => /\bBOT\b/.test(pl.textContent ?? '')));
    if (test === 'ranked-pair') {
      const a = await ranked('Asha', 1000);
      const b = await ranked('Leo', 1050);
      await search(a);
      await search(b);
      const both = (await inGame(a, 30000)) && (await inGame(b, 30000));
      const r = await play([a, b]);
      const rated = await Promise.all([a, b].map((p) => p.page.waitForFunction(() => !!document.querySelector('.result .rated'), null, { timeout: 15000 }).then(() => p.page.textContent('.result .rated')).catch(() => null)));
      await shots('end', a, b);
      report('ranked: two people matched by rating, and the rating changes', both && r.over?.length === 2 && rated.every(Boolean), `matched ${both}; ${r.steps} steps to the end; rating lines ${JSON.stringify(rated)}`);
      await close(a, b);
    } else if (test === 'ranked-botfill') {
      const a = await ranked('Asha', 1000);
      const t = Date.now();
      await search(a);
      const started = await inGame(a, 90000);
      const s = Math.round((Date.now() - t) / 1000);
      await a.page.waitForTimeout(1500);
      const names = await a.page.evaluate(() => [...document.querySelectorAll('.pl .nm')].map((n) => n.textContent));
      const shown = await botText(a);
      await shots('game', a);
      report('ranked: up to Gold III, a bot fills after the timeout, looking like a person', started && s >= 40 && !shown, `game after ${s} s; names ${JSON.stringify(names)}; "BOT" shown ${shown}`);
      // #221: the app plays the bot, and its runs go with this player's moves: the game only moves on if the server takes them.
      const r = started ? await play([a], { until: (n) => n >= 25, maxMs: 6 * 60000 }) : { steps: 0, stopped: false, ms: 0 };
      report('ranked: the bot is played in the app, and the server takes its moves', r.stopped || (r.over?.length ?? 0) > 0, `${r.steps} of the player's steps in ${Math.round(r.ms / 1000)} s${r.over?.length ? ' (game over)' : ''}`);
      await close(a);
    } else if (test === 'ranked-nobots') {
      const a = await ranked('Asha', 1500, true);
      await search(a);
      // The search with its timer, Cancel and (after 30 s) the hint.
      await a.page.waitForTimeout(36000);
      await shots('searching', a);
      const started = await inGame(a, 40000);
      const hint = await a.page.locator('.shint').isVisible().catch(() => false);
      const cancel = await a.page.locator('[data-act=cancel]').isVisible().catch(() => false);
      await shots('search', a);
      report('ranked: from Gold II up, no bots (still searching after 75 s)', !started && hint && cancel, `game started ${started}; hint shown ${hint}; cancel shown ${cancel}`);
      await close(a);
    } else if (test === 'ranked-lower') {
      const g = await ranked('Gold', 1320);
      const s = await ranked('Silver', 1250);
      const t = Date.now();
      await search(g);
      await search(s);
      const both = (await inGame(g, 60000)) && (await inGame(s, 60000));
      const secs = Math.round((Date.now() - t) / 1000);
      report('ranked: Gold widens into Silver (the league below) after 20 s', both && secs >= 18, `matched ${both} after ${secs} s`);
      await close(g, s);
    } else if (test === 'ranked-search') {
      // Any server, no test hook (the live one): a new account searches 1v1; after 30 s the private-room hint shows,
      // and Cancel (before the 45 s bot fill) goes back to the modes. A match with a real person meanwhile also passes.
      const p = await player('Asha', { phone: true });
      await openRanked(p);
      await shots('modes', p);
      await search(p);
      const searching = await p.page.locator('.wiz[data-step=search]').isVisible({ timeout: 10000 }).catch(() => false);
      await p.page.waitForTimeout(33000);
      const matched = await p.page.locator('.screen.game').isVisible().catch(() => false);
      const hint = await p.page.locator('.shint').isVisible().catch(() => false);
      const clock = (await p.page.textContent('.selapsed').catch(() => '')) ?? '';
      await shots('searching', p);
      let back = false;
      if (!matched) {
        await tap(p.page, '[data-act=cancel]');
        back = await p.page.locator('.wiz[data-step=modes]').isVisible({ timeout: 5000 }).catch(() => false);
        // Still back after the bot fill's time: the search really stopped.
        await p.page.waitForTimeout(15000);
        back = back && !(await p.page.locator('.screen.game').isVisible().catch(() => false));
      }
      report('ranked: search, the hint after 30 s, and Cancel', matched || (searching && hint && back), matched ? 'matched a real person meanwhile' : `searching ${searching}; clock ${clock.trim()}; hint ${hint}; Cancel back to the modes, no game after 48 s: ${back}`);
      await close(p);
    }
  } else if (test === 'chat') {
    // Chat (#212), against a server with chat: a quick phrase, an emoji, free text with a rude word, a mute, a report.
    const { host, guest } = await pair('1v1');
    const hasBtn = await host.page.locator('.chatbtn').isVisible({ timeout: 5000 }).catch(() => false);
    const openChat = async (p) => {
      await tap(p.page, '.chatbtn');
      await p.page.locator('.sheet.chat').waitFor({ timeout: 5000 });
    };
    await openChat(host);
    await tap(host.page, '.sheet.chat [data-quick="0"]');
    await host.page.waitForTimeout(1200);
    await tap(host.page, '.sheet.chat [data-emoji="0"]');
    await host.page.waitForTimeout(1200);
    await host.page.locator('.sheet.chat .ctext input').fill('well that was shit luck');
    await host.page.evaluate(() => document.querySelector('.sheet.chat .ctext').requestSubmit());
    await guest.page.waitForTimeout(1500);
    const bubbles = await guest.page.evaluate(() => [...document.querySelectorAll('.chattoast .cb')].map((b) => b.textContent));
    await openChat(guest);
    const log = await guest.page.evaluate(() => [...document.querySelectorAll('.sheet.chat .cl')].map((l) => l.querySelector('span')?.textContent));
    await shots('sheet', guest);
    // Report the text line, then mute the host: their lines disappear from the guest's log.
    await tap(guest.page, '.sheet.chat .crep');
    await guest.page.waitForTimeout(800);
    const reported = await guest.page.evaluate(() => document.querySelector('.sheet.chat .crep')?.textContent);
    await tap(guest.page, '.sheet.chat .cmute');
    const afterMute = await guest.page.evaluate(() => document.querySelectorAll('.sheet.chat .cl').length);
    await shots('end', host, guest);
    const textOk = log.includes('well that was s*** luck');
    report('chat: quick, emoji, filtered text, report, mute', hasBtn && log.length === 3 && textOk && reported === 'Reported' && afterMute === 0, `button ${hasBtn}; guest's bubbles ${JSON.stringify(bubbles)}; guest's log ${JSON.stringify(log)}; report ${reported}; lines after muting the host ${afterMute}`);
    await close(host, guest);
  } else if (test === 'abuse') {
    // #220: one client floods connections, messages, new rooms and new accounts from the same IP as a game in
    // progress; it gets cut off, and the game plays on. Our server only (wrangler dev, local).
    const base = process.env.VITE_ROOMS_URL ?? 'ws://localhost:8787';
    const http = base.replace(/^ws/, 'http');
    const { protocol, bots: botVersion } = await (await fetch(`${http}/health`)).json();
    const { host, guest, code } = await pair('1v1');
    await play([host, guest], { until: (n) => n >= 6 });
    const hex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    /** Opens a socket: 'open', or 'refused' (an error before opening: a 429 on the upgrade). */
    const sock = (q) => new Promise((res) => {
      const ws = new WebSocket(`${base}/ws?${q}`);
      const t = setTimeout(() => res({ ws, r: 'timeout' }), 10000);
      ws.onopen = () => { clearTimeout(t); res({ ws, r: 'open' }); };
      ws.onerror = () => { clearTimeout(t); res({ ws, r: 'refused' }); };
    });
    const attack = (async () => {
      // 1. 30 sockets into the game's room, none saying hello.
      const conns = await Promise.all(Array.from({ length: 30 }, () => sock(`code=${code}`)));
      const connRefused = conns.filter((c) => c.r !== 'open').length;
      // 2. Its own room, then 200 messages at once.
      const own = await sock(`create=${encodeURIComponent(JSON.stringify({ mode: '1v1', pairing: 'opposite', singles: true, botLevel: 'normal' }))}`);
      let cut = 'still open';
      if (own.r === 'open') {
        const closed = new Promise((res) => {
          own.ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.t === 'error') cut = m.code; };
          own.ws.onclose = (e) => res(e.code);
        });
        own.ws.send(JSON.stringify({ t: 'hello', protocol, botVersion, token: hex(), name: 'Flood' }));
        for (let i = 0; i < 200 && own.ws.readyState === 1; i++) own.ws.send(JSON.stringify({ t: 'chat', quick: 0 }));
        await Promise.race([closed, new Promise((r) => setTimeout(r, 5000))]);
      } else cut = `refused (${own.r})`;
      // 3. 40 new rooms, and 4. 30 new accounts.
      const rooms = await Promise.all(Array.from({ length: 40 }, () => sock(`create=${encodeURIComponent(JSON.stringify({ mode: '1v1', pairing: 'opposite', singles: true, botLevel: 'normal' }))}`)));
      const roomsRefused = rooms.filter((c) => c.r !== 'open').length;
      const accounts = await Promise.all(Array.from({ length: 30 }, () => fetch(`${http}/api/account`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Flood' }) }).then((r) => r.status)));
      const accountsRefused = accounts.filter((s) => s === 429).length;
      for (const c of [...conns, ...rooms, own]) try { c.ws.close(); } catch { /* gone */ }
      return { connRefused, cut, roomsRefused, accountsRefused };
    })();
    // Meanwhile the game goes on.
    const t = Date.now();
    const [a, r] = await Promise.all([attack, play([host, guest], { until: (n) => n >= 30 })]);
    const s = Math.round((Date.now() - t) / 1000);
    log('abuse:', JSON.stringify(a));
    report('a flood of connections into a room is turned away', a.connRefused >= 20, `${a.connRefused} of 30 refused (8 a room per IP, 2 of them the players')`);
    report('a flood of messages closes that connection', a.cut === 'rate-limited', `the flooding connection: ${a.cut}`);
    report('a flood of new rooms is turned away', a.roomsRefused >= 10, `${a.roomsRefused} of 40 refused`);
    report('a flood of new accounts is turned away', a.accountsRefused >= 10, `${a.accountsRefused} of 30 refused`);
    report('the game in progress plays on meanwhile', r.stopped && r.steps >= 30, `${r.steps} more steps in ${s} s`);
    await close(host, guest);
  } else if (test === 'share') {
    // #229: a game shared as a short link (kept on our server), opened in another browser; and the long link when
    // the terms weren't accepted. Our server (wrangler dev) and the dev build (its modules load in the page).
    /** Opens a replay of a short game (made in the page with the engine), ready to share. */
    const openReplay = async (p) => {
      await p.page.evaluate(async () => {
        const e = await import('/src/engine/index.ts');
        const seats = [{ color: 'blue', owner: 0, bot: false }, { color: 'green', owner: 1, bot: true, level: 'normal' }];
        let s = e.createGame(seats, 'blue', false);
        const rng = e.seeded(5);
        let ev = '';
        for (let i = 0; i < 80 && s.phase !== 'over'; i++) {
          if (s.phase === 'roll') { s = e.roll(s, rng); ev += e.rollEvent(s.dice); }
          else { const m = s.moves[0]; ev += e.moveEvent(m); s = e.move(s, m); }
        }
        const rec = { v: 1, seats, first: 'blue', meta: { mode: 'pvc', names: ['Asha', 'Bot'] }, events: ev };
        location.hash = '#game=' + (await e.encodeRecord(rec));
      });
      await p.page.locator('.screen.replay [data-act=share]').waitFor({ timeout: 20000 });
    };
    /** Taps SHARE GAME and returns the link it shares (the share menu stubbed to catch it). */
    const shareFrom = async (p) => {
      await p.page.evaluate(() => { window.__shared = null; navigator.share = async (d) => { window.__shared = d.url; }; });
      await tap(p.page, '.screen.replay [data-act=share]');
      await p.page.waitForFunction(() => !!window.__shared, null, { timeout: 20000 });
      return p.page.evaluate(() => window.__shared);
    };
    const a = await player('Asha', { phone: true });
    await openReplay(a);
    const url = await shareFrom(a);
    const code = /#g=([A-Z0-9]{12})$/.exec(url)?.[1] ?? null;
    report('share: a short link with a random code', !!code && url.length < 80, url);
    // Someone else opens it: the replay, then the review.
    const b = await player('Leo', { phone: true });
    let seen = false;
    let reviewed = false;
    if (code) {
      await b.page.goto(`${URL}#g=${code}`, { waitUntil: 'load' });
      seen = await b.page.locator('.screen.replay [data-act=share]').waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
      await shots('opened', b);
      if (seen) {
        await tap(b.page, '.screen.replay [data-act=review]');
        reviewed = await b.page.locator('.screen.review').waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
        await b.page.waitForTimeout(3000);
        await shots('review', b);
      }
    }
    report('share: the link opens the replay and the review in another browser', seen && reviewed, `replay ${seen}; review ${reviewed}`);
    // An unknown code: the broken-link screen, not a crash.
    await b.page.goto(`${URL}#g=ABCDEFGHJKLM`, { waitUntil: 'load' });
    const broken = await b.page.locator('.screen.replay.broken').waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
    report('share: an unknown code shows "This link is broken"', broken, `broken screen ${broken}`);
    // Terms not accepted: nothing goes to the server, the long link.
    const c = await player('Mia', { phone: true, decline: true });
    await openReplay(c);
    const long = await shareFrom(c);
    report('share: without the terms accepted, the long link (nothing uploaded)', long.includes('#game='), `${long.slice(0, 60)}… (${long.length} characters)`);
    await close(a, b, c);
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
