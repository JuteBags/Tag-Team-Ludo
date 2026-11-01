// The replay screen (#65): steps through a recorded game on the board, a move at a time or playing by
// itself, and shares it as a link. The game comes from the result screen, the Stats sheet's past games, or
// a shared link (untrusted: replay.ts cleans its names, and a record that doesn't replay never gets here).
import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import type { GameRecord } from '../engine';
import { avatarSVG, cssVars, icons } from './art';
import { BoardView } from './boardView';
import { dieMarkup } from './dice';
import { framesOf, namesOf, shareLink } from './replay';
import { SITE } from './shareCard';

const STEP_MS = 900;
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const PLAY = `<svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z" fill="#fff"/></svg>`;
const PAUSE = `<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1.5" fill="#fff"/><rect x="14" y="5" width="4" height="14" rx="1.5" fill="#fff"/></svg>`;
const flip = (back: boolean) => (back ? ' style="transform:scaleX(-1)"' : '');
const STEP = (back: boolean) => `<svg viewBox="0 0 24 24"${flip(back)}><path d="M6 5l9 7-9 7z" fill="#fff"/><rect x="16" y="5" width="3" height="14" rx="1.2" fill="#fff"/></svg>`;
const ENDS = (back: boolean) => `<svg viewBox="0 0 24 24"${flip(back)}><path d="M3 5l8 7-8 7zM11 5l8 7-8 7z" fill="#fff"/><rect x="19" y="5" width="2.6" height="14" rx="1.1" fill="#fff"/></svg>`;

export interface ReplayOptions {
  /** Open at the move made in this position (an index into the replay's states), and play it. */
  startAt?: number;
  /** Shows a REVIEW button (games with a person in them) that opens the game review. */
  onReview?: () => void;
}

/** A screen for `rec`; `onClose` goes back to where it was opened from. */
export function replayScreen(rec: GameRecord, onClose: () => void, opts: ReplayOptions = {}): HTMLElement {
  const { frames, error } = framesOf(rec);
  const names = namesOf(rec);
  const el = document.createElement('div');
  el.className = 'screen replay';
  const mode = rec.meta?.mode === 'pvp' ? 'WITH FRIENDS' : 'VS COMPUTER';
  const owners = [...new Set(rec.seats.map((s) => s.owner))].sort((a, b) => a - b);
  el.innerHTML = `
    <div class="gtop"><button class="rbtn" data-act="back" aria-label="Back">${icons.back}</button>
      <div class="mode"><small>REPLAY · ${mode}</small><b>${owners.length} PLAYERS</b></div>${opts.onReview && rec.seats.some((s) => !s.bot) ? '<button class="rbtn rvbtn" data-act="review" aria-label="Game review">★</button>' : '<span class="rbtn-space"></span>'}</div>
    <div class="rpchips"></div>
    <div class="gboard"></div>
    <div class="rpcap" aria-live="polite"><span class="rpdice"></span><span class="rptext"></span></div>
    <input class="rpscrub" type="range" min="0" max="${Math.max(0, frames.length - 1)}" value="0" aria-label="Move">
    <div class="rpctl">
      <button class="rbtn" data-act="first" aria-label="First move">${ENDS(true)}</button>
      <button class="rbtn" data-act="prev" aria-label="Previous move">${STEP(true)}</button>
      <button class="rbtn big" data-act="play" aria-label="Play">${PLAY}</button>
      <button class="rbtn" data-act="next" aria-label="Next move">${STEP(false)}</button>
      <button class="rbtn" data-act="last" aria-label="Last move">${ENDS(false)}</button>
    </div>
    <p class="rpcount"></p>
    <button class="sharebtn disp" data-act="share">${icons.share}<span>SHARE GAME</span></button>`;
  // Names go in as text, never as markup (they may come from a shared link).
  const chipBox = el.querySelector('.rpchips')!;
  owners.forEach((o, i) => {
    const c = rec.seats.find((s) => s.owner === o)!.color;
    const chip = document.createElement('span');
    chip.className = 'rpc';
    chip.setAttribute('style', cssVars(c));
    chip.innerHTML = `<i>${avatarSVG(c)}</i><b></b>`;
    chip.querySelector('b')!.textContent = names[i]!;
    chipBox.appendChild(chip);
  });
  const first = frames[0]?.state;
  const humans = rec.seats.filter((s) => !s.bot).map((s) => s.color);
  const view = new BoardView(first?.players ?? [], 370, humans, !!rec.singles, true);
  el.querySelector('.gboard')!.appendChild(view.el);
  const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;
  const scrub = q<HTMLInputElement>('.rpscrub');
  let at = 0;
  let timer = 0;
  let busy = false;

  const draw = () => {
    const f = frames[at];
    if (!f) return;
    q('.rptext').textContent = f.caption;
    q('.rpdice').innerHTML = f.dice.map((d) => `<i>${dieMarkup(d, 22)}</i>`).join('');
    q('.rpcount').textContent = frames.length > 1 ? `Step ${at} of ${frames.length - 1}` : '';
    scrub.value = String(at);
  };
  /** Shows frame `to`: one step forward animates the move, anything else snaps there. */
  const go = async (to: number) => {
    to = Math.max(0, Math.min(frames.length - 1, to));
    if (busy || to === at) return;
    const f = frames[to]!;
    if (to === at + 1 && f.move && !calm()) {
      busy = true;
      at = to;
      draw();
      await view.animateMove(f.move, f.state.players, 1.4);
      view.layout(f.state.players);
      busy = false;
    } else {
      at = to;
      view.layout(f.state.players);
      draw();
    }
  };
  const setPlaying = (on: boolean) => {
    q('[data-act=play]').innerHTML = on ? PAUSE : PLAY;
    q('[data-act=play]').setAttribute('aria-label', on ? 'Pause' : 'Play');
  };
  const stop = () => {
    clearTimeout(timer);
    timer = 0;
    setPlaying(false);
  };
  const tick = async () => {
    if (!el.isConnected || at >= frames.length - 1) return stop();
    await go(at + 1);
    timer = window.setTimeout(() => void tick(), STEP_MS);
  };
  el.addEventListener('click', async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'review') {
      stop();
      opts.onReview?.();
    } else if (act === 'back') {
      stop();
      onClose();
    } else if (act === 'play') {
      if (timer) return stop();
      if (at >= frames.length - 1) await go(0);
      setPlaying(true);
      timer = window.setTimeout(() => void tick(), 50);
    } else {
      stop();
      if (act === 'first') await go(0);
      else if (act === 'prev') await go(at - 1);
      else if (act === 'next') await go(at + 1);
      else if (act === 'last') await go(frames.length - 1);
      else if (act === 'share') await share(rec, q('[data-act=share] span'));
    }
  });
  scrub.addEventListener('input', () => {
    stop();
    void go(Number(scrub.value));
  });
  draw();
  if (error) q('.rpcount').textContent = error;
  // Opened at a reviewed move: show the position before it, then play the move.
  const f = opts.startAt === undefined ? -1 : frames.findIndex((x) => x.at === opts.startAt! + 1);
  if (f > 0) {
    at = f - 1;
    view.layout(frames[at]!.state.players);
    draw();
    setTimeout(() => el.isConnected && void go(f), 450);
  }
  return el;
}

/** The replay of a record from outside (a link or storage): anything that still breaks lands on the broken-link screen. */
export function safeReplayScreen(rec: GameRecord | null, onClose: () => void, opts: ReplayOptions = {}): HTMLElement {
  if (!rec) return brokenLinkScreen(onClose);
  try {
    return replayScreen(rec, onClose, opts);
  } catch {
    return brokenLinkScreen(onClose);
  }
}

/** Shares the game as a link: the share menu on Android or the web, or copied to the clipboard. */
async function share(rec: GameRecord, label: HTMLElement) {
  const url = await shareLink(rec, SITE);
  const text = 'Watch my game of Tag Team Ludo';
  try {
    if (Capacitor.isNativePlatform()) await Share.share({ title: 'Tag Team Ludo', text, url, dialogTitle: 'Share this game' });
    else if (navigator.share) await navigator.share({ title: 'Tag Team Ludo', text, url });
    else {
      await navigator.clipboard.writeText(url);
      label.textContent = 'LINK COPIED';
      setTimeout(() => (label.textContent = 'SHARE GAME'), 1800);
    }
  } catch {
    // Share sheet dismissed, or no clipboard: nothing to do.
  }
}

/** The screen for a link that couldn't be opened: damaged, cut off, or from another version. */
export function brokenLinkScreen(onHome: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'screen replay broken';
  el.innerHTML = `<div class="rpbroken"><h2 class="disp">This link is broken</h2><p class="sub">The game in it couldn't be opened. It may be cut off, or from a different version of the game.</p>
    <button class="b3 green disp" data-act="home">PLAY LUDO</button></div>`;
  el.querySelector('[data-act=home]')!.addEventListener('click', onHome);
  return el;
}
