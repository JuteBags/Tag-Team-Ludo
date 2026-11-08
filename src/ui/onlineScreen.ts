// With friends, online: private rooms. Create a room (the mode, doubles, how the bots play) or join one with its
// code, then wait in the lobby until the host starts; slots nobody takes are played by the server's bots. The
// game itself is the usual game screen, driven by the room (gameScreen.ts with a RoomLink).
import { copyWithFeedback } from './clipboard';
import type { Color } from '../engine';
import { PROFILES, avatarSVG, cssVars, icons } from './art';
import { RoomLink, loadRoom, roomsUrl } from '../net/client';
import { friendsSheet } from './friendsSheet';
import { requireTerms } from './legal';
import { MODE_NAME, modePicker, seatPic } from './modePicker';
import { CODE_LEN, MODE_LABEL, ONLINE_LEVELS, isCode, modeSlots, type GameSetup, type OnlineBotLevel, type RoomOptions } from '../net/protocol';
import { saveSetting, settings } from './settings';
import { NAME_MAX, cleanName, type GameConfig } from './setup';
import { sfx } from './sfx';
import { roomLinkUrl } from './replay';
import { SITE } from './shareCard';

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
export function onlineScreen(onGame: (link: RoomLink, cfg: GameConfig) => void, onBack: () => void, rejoin = false, join?: string): HTMLElement {
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
        ${saved && !saved.ranked ? `<button class="row2 q rejoin" data-act="rejoin"><span class="lbl">Back to room ${saved.code}</span><small class="qh">Your game goes on without you; jump back in</small><em class="chev" aria-hidden="true">${icons.next}</em></button>` : ''}
        ${configured ? `<button class="row2 q frbtn" data-act="friends"><span class="lbl">Friends</span><small class="qh">Add friends by code, see who’s online, invite them</small><em class="chev" aria-hidden="true">${icons.next}</em></button>` : ''}
        <p class="oerr" role="alert" hidden></p>
      </div></div>
      <button class="b3 blue disp go2" data-act="to-join">JOIN A ROOM</button>
      <button class="b3 green disp go" data-act="to-create">CREATE A ROOM</button>
    </section>
    <section class="wiz" data-step="create">
      <h3 class="disp">New room</h3><p class="sub">You're the host: you start the game</p>
      <div class="mid"><div class="sp opts">
        <i data-slot="modes"></i>
        <div class="row2 q"><span class="lbl">Doubles (pair moves)?</span>${tg('singles', [['false', 'On'], ['true', 'Off']], String(opts.singles))}</div>
        <div class="row2 q"><span class="lbl">How good are the bots?</span>${tg('level', ONLINE_LEVELS.map((l) => [l, cap(l)]), opts.botLevel)}<small class="qh lvlh">${LEVEL_NOTE[opts.botLevel]}</small></div>
        <p class="oerr" role="alert" hidden></p>
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
      <h3 class="disp">Private room</h3><p class="sub lsub"></p>
      <div class="mid"><div class="sp">
        <div class="codecard"><button class="codebtn" data-act="copy"><small>ROOM CODE</small><b class="code disp"></b><em class="copied" aria-live="polite">Tap to copy</em></button><button class="rbtn cpbtn" data-act="copy" aria-label="Copy the code">${icons.copy}</button><button class="rbtn shbtn" data-act="share" aria-label="Share the code">${icons.share}</button></div>
        <div class="lchips"></div>
        <div class="seats"></div>
        <p class="lnote"></p>
        <p class="lclock" aria-live="off"></p>
        <button class="sharecode inv" data-act="invite-friends">${icons.friends}<span>Invite friends</span></button>
      </div></div>
      <button class="b3 green disp go" data-act="start" disabled>START GAME</button>
    </section>`;
  // The mode picker is its own piece (modePicker.ts), so its design (#210) can change without this screen.
  el.querySelector('[data-slot=modes]')!.replaceWith(
    modePicker({ mode: opts.mode, pairing: opts.pairing }, (c) => {
      opts.mode = c.mode;
      opts.pairing = c.pairing;
    }),
  );

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
    const code = link.code;
    $('.code').textContent = code;
    $('.codebtn').setAttribute('aria-label', `Room code ${code.split('').join(' ')}. Tap to copy`);
    // Before the room is known it's still connecting; after, a drop is a reconnect (the seats stay as they were).
    const net = link.status === 'open' ? '' : !o ? (link.status === 'retrying' ? 'Connecting… (trying again)' : 'Connecting…') : 'Connection lost. Reconnecting…';
    el.querySelector('.wiz[data-step=lobby]')!.classList.toggle('offline', !!net && !!o);
    if (!o) {
      $('.lsub').textContent = net || 'Connecting…';
      $('.seats').innerHTML = '';
      $('.lchips').innerHTML = '';
      return;
    }
    const n = link.members.length;
    const host = link.you === 0;
    const slots = modeSlots(o.mode, o.pairing);
    const total = slots.length;
    $('.lsub').textContent = net || `${n} of ${total} here`;
    $('.lchips').innerHTML = `<span class="lchip mode">${seatPic(o.mode, o.pairing, 22)}<span class="lname">${MODE_NAME[o.mode]}</span></span><span class="lchip">${o.singles ? 'No doubles' : 'Doubles'}</span><span class="lchip">${cap(o.botLevel)} bots</span>`;
    const seat = (i: number) => {
      const slot = slots[i]!;
      const m = link!.members[i];
      const you = i === link!.you;
      const tag = [o.mode === '2v2' ? TEAM[slot.side] : '', m ? (you ? 'YOU' : m.host ? 'HOST' : !m.online ? 'OFFLINE' : '') : ''].filter(Boolean).join(' · ');
      const faces = slot.colors.map((x) => `<span class="ra" style="${cssVars(x)}">${avatarSVG(x)}</span>`).join('');
      const name = document.createElement('b');
      name.textContent = m ? m.name : 'Open';
      return `<div class="seat${m ? '' : ' empty'}${m && !m.online ? ' away' : ''}${slot.colors.length > 1 ? ' two' : ''}" style="${cssVars(slot.colors[0]!)}">${faces}${name.outerHTML}${tag ? `<em>${tag}</em>` : ''}</div>`;
    };
    $('.seats').innerHTML = slots.map((_, i) => seat(i)).join('');
    const start = $<HTMLButtonElement>('[data-act=start]');
    start.disabled = !host || n < 2 || link.status !== 'open';
    start.textContent = host ? (n < 2 ? 'WAITING FOR FRIENDS' : n < total ? `START WITH ${total - n} BOT${total - n > 1 ? 'S' : ''}` : 'START GAME') : 'WAITING FOR THE HOST';
    $('.lnote').textContent = n < total ? `Open seats play as ${cap(o.botLevel)} bots` : '';
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

  /**
   * Connects only once the Privacy note and Terms of use are accepted (#208): accepted once on this device, it
   * never asks again; the sheet shows only if they weren't accepted, or a newer version came out. Declined: no
   * connection.
   */
  // Where the connection was asked for: a room that can't be joined or made (a bad, full, started or expired
  // code; the server down) says so there, with what was typed kept (#232), not on another screen.
  let from: Step = 'menu';
  const connect = (make: () => RoomLink) => {
    from = step;
    void requireTerms(el).then((ok) => ok && attach(make()));
  };
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
        show(from === 'join' || from === 'create' ? from : 'menu');
        error(l.fatal.message);
        if (from === 'join') {
          codeIn.focus();
          codeIn.select();
        }
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
  /** #238: a room link's code waiting for a name, and joining it from Join (where its errors show). */
  let linked = '';
  /**
   * The menu while a room link waits for the name (ludo-uiux, #241): the room in the title, JOIN <code> as the one
   * green button, nothing else to tap. '' puts the usual menu back.
   */
  const linkView = (code: string) => {
    linked = code;
    const menu = $('.wiz[data-step=menu]');
    menu.querySelector('h3')!.innerHTML = code ? `Join room <b class="disp">${code}</b>` : 'Private room';
    menu.querySelector('.sub')!.textContent = code ? 'Your name first, so they know who’s joining.' : 'Friends play on their own phones';
    const go = menu.querySelector<HTMLElement>('[data-act=to-join]')!;
    go.textContent = code ? `JOIN ${code}` : 'JOIN A ROOM';
    go.classList.toggle('green', !!code);
    go.classList.toggle('blue', !code);
    for (const q of ['[data-act=to-create]', '.frbtn', '.rejoin']) {
      const b = menu.querySelector<HTMLElement>(q);
      if (b) b.style.display = code ? 'none' : '';
    }
  };
  const joinLinked = (code: string) => {
    show('join');
    connect(() => RoomLink.join(code, myName()));
  };
  el.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-act]');
    const tb = (e.target as Element).closest<HTMLButtonElement>('.tg button');
    // The mode picker (modePicker.ts) handles its own taps.
    if (tb && !tb.closest('[data-k=mode], [data-k=pairing]')) {
      sfx.tick();
      const k = tb.parentElement!.dataset.k!;
      tb.parentElement!.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === tb));
      const v = tb.dataset.v!;
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
      // Back from a room link waiting for the name: the link is dropped, the usual menu.
      if (step === 'menu' && linked) {
        linkView('');
        return;
      }
      if (step === 'menu') {
        leaveRoom();
        return onBack();
      }
      if (step === 'lobby') leaveRoom();
      show('menu');
      error('');
    } else if (!configured && (act === 'to-create' || act === 'to-join' || act === 'rejoin')) {
      error('Online play isn’t set up in this version of the app.');
    } else if (act === 'friends') {
      keepName();
      void friendsSheet(el);
    } else if (act === 'invite-friends') {
      void friendsSheet(el, link?.code);
    } else if (act === 'to-create') {
      keepName();
      show('create');
    } else if (act === 'to-join' && linked) {
      // The room link waiting for a name (#238).
      keepName();
      const code = linked;
      linkView('');
      joinLinked(code);
    } else if (act === 'to-join') {
      keepName();
      show('join');
      setTimeout(() => codeIn.focus(), 50);
    } else if (act === 'create') {
      connect(() => RoomLink.create({ ...opts }, myName()));
    } else if (act === 'join') {
      connect(() => RoomLink.join(codeIn.value, myName()));
    } else if (act === 'rejoin') {
      const r = loadRoom();
      if (r) connect(() => RoomLink.join(r.code, r.name, r.token));
    } else if (act === 'start') {
      link?.send({ t: 'start' });
    } else if (act === 'copy' && link?.code) {
      copyWithFeedback(link.code, el.querySelector('.cpbtn'), el.querySelector('.codebtn .copied'), 'Tap to copy', icons);
    } else if (act === 'share' && link?.code) {
      // #238: the room link, which opens the game (or the app) and joins.
      const url = roomLinkUrl(link.code, SITE);
      const text = `Join my Tag Team Ludo room ${link.code}: ${url}`;
      const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
      if (nav.share) void nav.share({ text }).catch(() => undefined);
      else copyWithFeedback(url, el.querySelector('.cpbtn'), el.querySelector('.codebtn .copied'), 'Tap to copy', icons);
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
  if (rejoin && saved && configured) connect(() => RoomLink.join(saved.code, saved.name, saved.token));
  // An invite from a friend (#209): straight into their room.
  // A room link (#238) shows the code on Join, so a full, started or unknown room says so there. Without a saved name
  // it stops at the name first (ludo-uiux): JOIN A ROOM then joins that room straight away.
  else if (join && configured) {
    codeIn.value = join;
    console.info(`[ludo-link] join step ${join}`);
    $<HTMLButtonElement>('[data-act=join]').disabled = !isCode(join);
    if (settings.myName?.trim()) joinLinked(join);
    else {
      linkView(join);
      setTimeout(() => nameIn.focus(), 50);
    }
  }
  return el;
}
