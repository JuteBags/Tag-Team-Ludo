// With friends, online: private rooms. Create a room (the mode, doubles, how the bots play) or join one with its
// code, then wait in the lobby until the host starts; slots nobody takes are played by the server's bots. The
// game itself is the usual game screen, driven by the room (gameScreen.ts with a RoomLink).
import type { Color } from '../engine';
import { PROFILES, avatarSVG, cssVars, icons } from './art';
import { RoomLink, loadRoom, roomsUrl } from '../net/client';
import { CODE_LEN, GAME_MODES, MODE_LABEL, MODE_NOTE, ONLINE_LEVELS, isCode, modeSlots, type GameSetup, type OnlineBotLevel, type RoomOptions } from '../net/protocol';
import { saveSetting, settings } from './settings';
import { NAME_MAX, cleanName, type GameConfig } from './setup';
import { sfx } from './sfx';

type Step = 'menu' | 'create' | 'join' | 'lobby';
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const LEVEL_NOTE: Record<OnlineBotLevel, string> = {
  easy: 'Simple, sensible moves.',
  normal: "Good moves, but doesn't plan the whole turn.",
  hard: 'Plans the whole turn.',
};
/** A name for a bot's house in an online game (blue is always a person: the host). */
const botName = (c: Color) => (c === 'blue' ? 'Bot' : PROFILES[c].name);

/**
 * The game screen's config for a room's game: each side's name (a person, a team "A & B", or a bot named after
 * its colour), and the name of whoever plays each colour.
 */
export function onlineConfig(setup: GameSetup): GameConfig {
  const sides = [...new Set(setup.seats.map((s) => s.owner))].sort((a, b) => a - b);
  const colorNames: Partial<Record<Color, string>> = {};
  for (const s of setup.seats) {
    const who = setup.control[s.color] ?? -1;
    colorNames[s.color] = who >= 0 ? (setup.people[who] ?? 'Player') : botName(s.color);
  }
  return {
    mode: 'pvp',
    seats: setup.seats,
    first: setup.first,
    singles: setup.singles,
    names: sides.map((side) => setup.names[side] || botName(setup.seats.find((s) => s.owner === side)!.color)),
    colorNames,
  };
}

/** The tag over a slot in a 2v2 lobby: which team it's on. */
const TEAM = ['TEAM A', 'TEAM B'];

/**
 * `onGame`: the room's game started (or was already under way when rejoining): open the game screen with
 * the link. `rejoin`: go straight back into the room this device was in.
 */
export function onlineScreen(onGame: (link: RoomLink, cfg: GameConfig) => void, onBack: () => void, rejoin = false): HTMLElement {
  let step: Step = 'menu';
  let link: RoomLink | null = null;
  let off: (() => void) | null = null;
  const opts: RoomOptions = { mode: 'ffa', pairing: 'opposite', singles: !settings.doubles, botLevel: settings.botLevel === 'easy' || settings.botLevel === 'hard' ? settings.botLevel : 'normal' };
  const saved = loadRoom();
  const configured = !!roomsUrl();

  const el = document.createElement('div');
  el.className = 'screen setup online';
  const tg = (k: string, items: [string, string][], on: string) => `<div class="tg" data-k="${k}">${items.map(([v, t]) => `<button data-v="${v}"${v === on ? ' class="on"' : ''}>${t}</button>`).join('')}</div>`;
  el.innerHTML = `
    <div class="gtop"><button class="rbtn" data-act="back" aria-label="Back">${icons.back}</button>
      <div class="mode"><small>WITH FRIENDS · ONLINE</small><b>PRIVATE ROOM</b></div><span class="rbtn-space"></span></div>
    <section class="wiz quickfoot" data-step="menu">
      <h3 class="disp">Private room</h3><p class="sub">Friends play on their own phones</p>
      <div class="mid"><div class="sp">
        <label class="row2 q"><span class="lbl">Your name</span><input class="namein" maxlength="${NAME_MAX}" autocomplete="nickname" spellcheck="false" placeholder="Your name"></label>
        ${saved ? `<button class="row2 q rejoin" data-act="rejoin"><span class="lbl">Back to room ${saved.code}</span><small class="qh">Your game goes on without you; jump back in</small><em class="chev" aria-hidden="true">${icons.next}</em></button>` : ''}
        <p class="oerr" role="alert" hidden></p>
      </div></div>
      <button class="b3 blue disp go2" data-act="to-join">JOIN A ROOM</button>
      <button class="b3 green disp go" data-act="to-create">CREATE A ROOM</button>
    </section>
    <section class="wiz" data-step="create">
      <h3 class="disp">New room</h3><p class="sub">You're the host: you start the game</p>
      <div class="mid"><div class="sp opts">
        <div class="row2 q"><span class="lbl">Which game?</span>${tg('mode', GAME_MODES.map((m) => [m, MODE_LABEL[m]]), opts.mode).replace('class="tg"', 'class="tg grid2"')}<small class="qh mnote">${MODE_NOTE[opts.mode]}. Places nobody takes are played by bots</small></div>
        <div class="row2 q pairq" hidden><span class="lbl">Where are your two colours?</span>${tg('pairing', [['opposite', 'Opposite'], ['adjacent', 'Side by side']], opts.pairing)}</div>
        <div class="row2 q"><span class="lbl">Doubles (pair moves)?</span>${tg('singles', [['false', 'On'], ['true', 'Off']], String(opts.singles))}</div>
        <div class="row2 q"><span class="lbl">How good are the bots?</span>${tg('level', ONLINE_LEVELS.map((l) => [l, cap(l)]), opts.botLevel)}<small class="qh lvlh">${LEVEL_NOTE[opts.botLevel]}</small></div>
      </div></div>
      <button class="b3 green disp go" data-act="create">CREATE ROOM</button>
    </section>
    <section class="wiz" data-step="join">
      <h3 class="disp">Join a room</h3><p class="sub">Type the code your friend shares</p>
      <div class="mid"><div class="sp">
        <input class="codein disp" maxlength="${CODE_LEN}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="CODE" aria-label="Room code">
        <p class="oerr" role="alert" hidden></p>
      </div></div>
      <button class="b3 green disp go" data-act="join" disabled>JOIN</button>
    </section>
    <section class="wiz" data-step="lobby">
      <h3 class="disp">Room <span class="code"></span></h3><p class="sub lsub"></p>
      <div class="mid"><div class="sp">
        <button class="sharecode" data-act="share">${icons.share}<span>Share the code</span></button>
        <div class="seats"></div>
        <p class="lnote"></p>
        <p class="lclock" aria-live="off"></p>
      </div></div>
      <button class="b3 green disp go" data-act="start" disabled>START GAME</button>
    </section>`;

  const $ = <T extends HTMLElement>(q: string) => el.querySelector<T>(q)!;
  const nameIn = $<HTMLInputElement>('.namein');
  nameIn.value = settings.myName;
  const myName = () => cleanName(nameIn.value, 'Player');
  const codeIn = $<HTMLInputElement>('.codein');

  const show = (s: Step) => {
    step = s;
    el.querySelectorAll<HTMLElement>('.wiz').forEach((w) => (w.hidden = w.dataset.step !== s));
  };
  const error = (text: string) => {
    el.querySelectorAll<HTMLElement>(`.wiz[data-step=${step}] .oerr`).forEach((p) => {
      p.textContent = text;
      p.hidden = !text;
    });
  };

  // ---------- lobby ----------
  const drawLobby = () => {
    if (!link) return;
    const o = link.options;
    $('.code').textContent = link.code;
    if (!o) {
      $('.lsub').textContent = link.status === 'retrying' ? 'Connecting… (trying again)' : 'Connecting…';
      $('.seats').innerHTML = '';
      return;
    }
    const n = link.members.length;
    const host = link.you === 0;
    const slots = modeSlots(o.mode, o.pairing);
    const total = slots.length;
    $('.lsub').textContent = link.status === 'open' ? `${MODE_LABEL[o.mode]} · ${n} of ${total} here · ${o.singles ? 'no doubles' : 'doubles'} · ${cap(o.botLevel)} bots` : 'Connection lost. Reconnecting…';
    $('.seats').innerHTML = slots
      .map((slot, i) => {
        const m = link!.members[i];
        const c = slot.colors[0]!;
        const who = m ? `${m.name}${i === link!.you ? ' (you)' : ''}` : 'Waiting…';
        const tag = [o.mode === '2v2' ? TEAM[slot.side] : '', m ? (m.host ? 'HOST' : !m.online ? 'OFFLINE' : '') : 'BOT IF EMPTY'].filter(Boolean).join(' · ');
        const faces = slot.colors.map((x) => `<span class="ra" style="${cssVars(x)}">${avatarSVG(x)}</span>`).join('');
        return `<div class="seat${m ? '' : ' empty'}${slot.colors.length > 1 ? ' two' : ''}" style="${cssVars(c)}">${faces}<b>${who}</b>${tag ? `<em>${tag}</em>` : ''}</div>`;
      })
      .join('');
    const start = $<HTMLButtonElement>('[data-act=start]');
    start.disabled = !host || n < 2 || link.status !== 'open';
    start.textContent = host ? (n < 2 ? 'WAITING FOR FRIENDS' : n < total ? `START WITH ${total - n} BOT${total - n > 1 ? 'S' : ''}` : 'START GAME') : 'WAITING FOR THE HOST';
    $('.lnote').textContent = host ? 'Share the code. Start when everyone is in; empty colours get bots.' : 'The host starts the game when everyone is in.';
    tick();
  };

  /** The lobby's countdown: the game starts by itself (or the room closes) when it reaches 0:00. */
  const tick = () => {
    const clock = $('.lclock');
    if (!link?.options || step !== 'lobby') return (clock.textContent = '');
    const s = Math.max(0, Math.ceil((link.lobbyEnds - performance.now()) / 1000));
    const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    clock.classList.toggle('low', s <= 20);
    clock.textContent = link.members.length < 2 ? `Room closes in ${t} if nobody joins` : `Game starts by itself in ${t}`;
  };
  const clockTimer = setInterval(() => (el.isConnected ? tick() : clearInterval(clockTimer)), 500);

  const attach = (l: RoomLink) => {
    off?.();
    link = l;
    off = l.on((m) => {
      if (m.t === 'game') {
        off?.();
        off = null;
        onGame(l, onlineConfig(m.setup));
        return;
      }
      if (m.t === 'error' && l.fatal) {
        link = null;
        off?.();
        off = null;
        show(step === 'lobby' ? 'menu' : step);
        error(l.fatal.message);
        return;
      }
      if (m.t === 'error') sfx.tick();
      drawLobby();
    });
    show('lobby');
    drawLobby();
  };

  const leaveRoom = () => {
    off?.();
    off = null;
    link?.leave();
    link = null;
  };

  // ---------- actions ----------
  const keepName = () => saveSetting('myName', nameIn.value.trim() ? myName() : '');
  el.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-act]');
    const tb = (e.target as Element).closest<HTMLButtonElement>('.tg button');
    if (tb) {
      sfx.tick();
      const k = tb.parentElement!.dataset.k!;
      tb.parentElement!.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === tb));
      const v = tb.dataset.v!;
      if (k === 'mode') {
        opts.mode = v as RoomOptions['mode'];
        $('.mnote').textContent = `${MODE_NOTE[opts.mode]}. Places nobody takes are played by bots`;
        $('.pairq').hidden = opts.mode !== 'duo';
      }
      if (k === 'pairing') opts.pairing = v as RoomOptions['pairing'];
      if (k === 'singles') opts.singles = v === 'true';
      if (k === 'level') {
        opts.botLevel = v as OnlineBotLevel;
        $('.lvlh').textContent = LEVEL_NOTE[opts.botLevel];
      }
      return;
    }
    if (!b) return;
    const act = b.dataset.act;
    if (act !== 'back') sfx.tick();
    if (act === 'back') {
      if (step === 'menu') {
        leaveRoom();
        return onBack();
      }
      if (step === 'lobby') leaveRoom();
      show('menu');
      error('');
    } else if (!configured && (act === 'to-create' || act === 'to-join' || act === 'rejoin')) {
      error('Online play isn’t set up in this version of the app.');
    } else if (act === 'to-create') {
      keepName();
      show('create');
    } else if (act === 'to-join') {
      keepName();
      show('join');
      setTimeout(() => codeIn.focus(), 50);
    } else if (act === 'create') {
      attach(RoomLink.create({ ...opts }, myName()));
    } else if (act === 'join') {
      attach(RoomLink.join(codeIn.value, myName()));
    } else if (act === 'rejoin') {
      const r = loadRoom();
      if (r) attach(RoomLink.join(r.code, r.name, r.token));
    } else if (act === 'start') {
      link?.send({ t: 'start' });
    } else if (act === 'share' && link?.code) {
      const text = `Join my Tag Team Ludo room: ${link.code}`;
      const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
      const done = () => {
        const s = b.querySelector('span')!;
        s.textContent = 'Code copied!';
        setTimeout(() => (s.textContent = 'Share the code'), 1600);
      };
      if (nav.share) void nav.share({ text }).catch(() => undefined);
      else void navigator.clipboard?.writeText(link.code).then(done, () => undefined);
    }
  });
  codeIn.addEventListener('input', () => {
    const v = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (v !== codeIn.value) codeIn.value = v;
    $<HTMLButtonElement>('[data-act=join]').disabled = !isCode(v);
    error('');
  });
  codeIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && isCode(codeIn.value)) $<HTMLButtonElement>('[data-act=join]').click();
  });
  nameIn.addEventListener('change', keepName);

  show('menu');
  if (rejoin && saved && configured) attach(RoomLink.join(saved.code, saved.name, saved.token));
  return el;
}
