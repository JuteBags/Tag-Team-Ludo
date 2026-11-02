// The replay screen (#65): steps through a recorded game on the board, a move at a time or playing by
// itself, and shares it as a link. The game comes from the result screen, the Stats sheet's past games, or
// a shared link (untrusted: replay.ts cleans its names, and a record that doesn't replay never gets here).
// With a review (#96) it's in review mode: the player chips pick whose side (the POV), every reviewed move
// of theirs gets its verdict in the caption, the board shows the move played and the best one ("Show best
// move"), a win-chance bar shows everyone's chances as you step, the scrubber has ticks at their mistakes,
// captures and the turning point, and the outer buttons jump between mistakes.
import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { replay, type GameRecord, type GameState } from '../engine';
import type { MoveReview } from '../engine/ai/review';
import { avatarSVG, cssVars, icons, PALETTE } from './art';
import { BoardView } from './boardView';
import { dieMarkup } from './dice';
import { framesOf, namesOf, shareLink, type Frame } from './replay';
import { follow } from './reviewQueue';
import { peopleOf, type ReviewProgress } from './reviewRun';
import { KEY_LABELS, LABEL_LOOK, turningPoint, verdictText } from './reviewText';
import { SITE } from './shareCard';
import type { StoredReview } from './store';

const STEP_MS = 900;
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const PLAY = `<svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z" fill="#fff"/></svg>`;
const PAUSE = `<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1.5" fill="#fff"/><rect x="14" y="5" width="4" height="14" rx="1.5" fill="#fff"/></svg>`;
const flip = (back: boolean) => (back ? ' style="transform:scaleX(-1)"' : '');
const STEP = (back: boolean) => `<svg viewBox="0 0 24 24"${flip(back)}><path d="M6 5l9 7-9 7z" fill="#fff"/><rect x="16" y="5" width="3" height="14" rx="1.2" fill="#fff"/></svg>`;
const ENDS = (back: boolean) => `<svg viewBox="0 0 24 24"${flip(back)}><path d="M3 5l8 7-8 7zM11 5l8 7-8 7z" fill="#fff"/><rect x="19" y="5" width="2.6" height="14" rx="1.1" fill="#fff"/></svg>`;
/** Jump to the previous / next mistake: a step arrow with a "?" badge. */
const JUMP = (back: boolean) => `<svg viewBox="0 0 24 24"><path d="${back ? 'M9 6L2 12l7 6z' : 'M15 6l7 6-7 6z'}" fill="#fff"/><circle cx="${back ? 15 : 9}" cy="12" r="7.5" fill="#fb923c" stroke="#fff" stroke-width="1.5"/><text x="${back ? 15 : 9}" y="16" text-anchor="middle" font-size="12" font-weight="900" fill="#1a1300">?</text></svg>`;

const BEST_KEY = 'ludo-show-best';
const loadShowBest = () => {
  try {
    return localStorage.getItem(BEST_KEY) !== '0';
  } catch {
    return true;
  }
};

export interface ReplayOptions {
  /** Open at the first move after this position (an index into the replay's states), and play it. */
  startAt?: number;
  /** The caption for that move instead of the usual one: the review's verdict on it. */
  startCaption?: string;
  /** Shows a Review button (games with a person in them) that opens the game review, from the side shown. */
  onReview?: (pov: number) => void;
  /** The game's stored review, if any: the replay opens in review mode. */
  review?: StoredReview;
  /** Whose side the review mode shows (default: the first person). */
  pov?: number;
  /** The review is kept with the past game (false for a game from a link). */
  keep?: boolean;
}

/** A screen for `rec`; `onClose` goes back to where it was opened from. */
export function replayScreen(rec: GameRecord, onClose: () => void, opts: ReplayOptions = {}): HTMLElement {
  const { frames, error } = framesOf(rec);
  const names = namesOf(rec);
  const el = document.createElement('div');
  el.className = 'screen replay';
  const mode = rec.meta?.mode === 'pvp' ? 'WITH FRIENDS' : 'VS COMPUTER';
  const owners = [...new Set(rec.seats.map((s) => s.owner))].sort((a, b) => a - b);
  const people = peopleOf(rec);
  const colorOf = (o: number) => rec.seats.find((s) => s.owner === o)!.color;
  const isYou = (o: number) => (rec.meta?.mode !== 'pvp' ? people.includes(o) : names[o] === 'You');
  el.innerHTML = `
    <div class="gtop"><button class="rbtn" data-act="back" aria-label="Back">${icons.back}</button>
      <div class="mode"><small>REPLAY · ${mode}</small><b>${owners.length} PLAYERS</b></div>${opts.onReview && people.length ? '<button class="rvbtn disp" data-act="review">Review</button>' : '<span class="rbtn-space"></span>'}</div>
    <div class="rpchips" role="tablist" aria-label="Whose side"></div>
    <div class="wcbar" hidden aria-hidden="true"></div>
    <div class="gboard"></div>
    <div class="rpcap" aria-live="polite"><span class="rpdice"></span><span class="rptext"></span><button class="bestchip" data-act="best" hidden aria-pressed="true">Show best move</button></div>
    <input class="rpscrub" type="range" min="0" max="${Math.max(0, frames.length - 1)}" value="0" aria-label="Move">
    <svg class="rpticks" hidden aria-hidden="true" preserveAspectRatio="none"></svg>
    <div class="rpctl">
      <button class="rbtn" data-act="first" aria-label="First move">${ENDS(true)}</button>
      <button class="rbtn" data-act="prev" aria-label="Previous move">${STEP(true)}</button>
      <button class="rbtn big" data-act="play" aria-label="Play">${PLAY}</button>
      <button class="rbtn" data-act="next" aria-label="Next move">${STEP(false)}</button>
      <button class="rbtn" data-act="last" aria-label="Last move">${ENDS(false)}</button>
    </div>
    <p class="rpcount"></p>
    <button class="sharebtn disp" data-act="share">${icons.share}<span>SHARE GAME</span></button>`;
  const q = <T extends Element>(s: string) => el.querySelector<T>(s)!;
  // Names go in as text, never as markup (they may come from a shared link).
  const chipBox = q('.rpchips');
  owners.forEach((o, i) => {
    const chip = document.createElement('button');
    chip.className = 'rpc';
    chip.dataset.pov = String(o);
    chip.setAttribute('style', cssVars(colorOf(o)));
    chip.innerHTML = `<i>${avatarSVG(colorOf(o))}</i><b></b>`;
    chip.querySelector('b')!.textContent = names[i]!;
    chipBox.appendChild(chip);
  });
  const first = frames[0]?.state;
  const humans = rec.seats.filter((s) => !s.bot).map((s) => s.color);
  const view = new BoardView(first?.players ?? [], 370, humans, !!rec.singles, true);
  q('.gboard').appendChild(view.el);
  const scrub = q<HTMLInputElement>('.rpscrub');
  let at = 0;
  let timer = 0;
  let busy = false;
  // Captions that replace a frame's usual one (the review's verdict on the move it was opened at).
  const notes = new Map<number, string>();
  const ring = (f: Frame) => view.markMoved(f.move ? f.move.tokens.map((t) => f.move!.color + t) : []);

  // Review mode: the review's verdicts, from one side.
  let pov = opts.pov ?? people[0] ?? owners[0]!;
  let showBest = loadShowBest();
  let moves: MoveReview[] = opts.review?.moves ?? [];
  let chances: number[][] | null = opts.review?.chances ?? null;
  let luck = opts.review?.luck ?? null;
  /** The reviewed decision a frame's move was made in, for the side shown. */
  const verdictOf = (f: Frame | undefined): MoveReview | undefined => (f?.move ? moves.find((m) => m.at === f.at - 1 && m.owner === pov) : undefined);
  // The position each move was made in (the verdict's state): the previous frame's state won't do, since
  // rolls sit between them, so it comes from the record's own replay.
  const allStates = replay(rec).states;
  const statesOf = (f: Frame): GameState | undefined => (f.at > 0 ? allStates[f.at - 1] : undefined);
  const reviewOn = () => moves.length > 0;

  const markCaption = (text: string) => {
    // Captures in red and tokens home in gold; the text itself is set as text, never as markup.
    const box = q('.rptext');
    box.replaceChildren();
    const re = /(, capturing [^,]+|, (?:a token|\d tokens) home)/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      box.append(text.slice(last, m.index));
      const span = document.createElement('span');
      span.className = m[0].includes('capturing') ? 'cap' : 'home';
      span.textContent = m[0];
      box.append(span);
      last = m.index! + m[0].length;
    }
    box.append(text.slice(last));
  };

  const drawBar = () => {
    const bar = q<HTMLElement>('.wcbar');
    const f = frames[at];
    const c = f && chances?.[f.at];
    bar.hidden = !reviewOn() || !c;
    if (!c) return;
    const total = c.reduce((a, x) => a + x, 0) || 1;
    bar.innerHTML = owners
      .map((o) => {
        const w = (100 * (c[o] ?? 0)) / total;
        return `<i style="width:${w.toFixed(1)}%;background:${PALETTE[colorOf(o)].m}">${o === pov && w >= 12 ? `${Math.round(c[o] ?? 0)}%` : ''}</i>`;
      })
      .join('');
  };

  const drawTicks = () => {
    const svg = q<SVGSVGElement>('.rpticks');
    svg.toggleAttribute('hidden', !reviewOn());
    if (!reviewOn() || frames.length < 2) return;
    const n = frames.length - 1;
    const x = (i: number) => ((100 * i) / n).toFixed(2);
    let s = '';
    frames.forEach((f, i) => {
      if (f.move?.captures.length) s += `<rect x="${x(i)}" y="9" width=".5" height="5" fill="#f87171"/>`;
      const v = verdictOf(f);
      if (v && KEY_LABELS.includes(v.label)) s += `<rect x="${x(i)}" y="0" width=".9" height="9" fill="${LABEL_LOOK[v.label].color}"/>`;
    });
    const tp = luck ? turningPoint(moves.filter((m) => m.owner === pov), luck, pov) : null;
    if (tp) {
      const i = frames.findIndex((f) => f.at > (tp.kind === 'move' ? tp.move.at : tp.roll.at));
      if (i >= 0) s += `<text x="${x(i)}" y="9" font-size="9" text-anchor="middle" fill="#ffd65a">★</text>`;
    }
    svg.setAttribute('viewBox', '0 0 100 14');
    svg.innerHTML = s;
  };

  const draw = () => {
    const f = frames[at];
    if (!f) return;
    const v = reviewOn() ? verdictOf(f) : undefined;
    const s = v ? statesOf(f) : undefined;
    const text = notes.get(at) ?? (v && s ? (() => {
      const t = verdictText(v, s, isYou(v.owner) ? 'You' : names[v.owner]!, (c) => { const o = rec.seats.find((x) => x.color === c)?.owner ?? 0; return isYou(o) ? 'you' : names[o]!; });
      return `${LABEL_LOOK[v.label].sym} ${t.head} · ${t.line}`;
    })() : f.caption);
    markCaption(text);
    q('.rpcap').classList.toggle('verdict', !!v || notes.has(at));
    q('.rpdice').innerHTML = f.dice.map((d) => `<i>${dieMarkup(d, 22)}</i>`).join('');
    q('.rpcount').textContent = frames.length > 1 ? `Step ${at} of ${frames.length - 1}` : '';
    scrub.value = String(at);
    // The board: the move played and the best one, on a reviewed move of the side shown.
    const chip = q<HTMLButtonElement>('.bestchip');
    chip.hidden = !v || v.label === 'best';
    chip.setAttribute('aria-pressed', String(showBest));
    chip.textContent = showBest ? 'Hide best move' : 'Show best move';
    const look = v ? LABEL_LOOK[v.label] : null;
    view.showVerdict(v && s && look && !busy ? { played: s.moves[v.played]!, best: showBest && v.played !== v.best && v.label !== 'best' ? s.moves[v.best] : undefined, sym: look.sym, color: look.color } : null);
    drawBar();
  };

  /** Review mode on or off, and its controls: the outer buttons jump between mistakes. */
  const drawMode = () => {
    el.classList.toggle('rvmode', reviewOn());
    chipBox.querySelectorAll<HTMLElement>('.rpc').forEach((c) => {
      c.classList.toggle('on', reviewOn() && Number(c.dataset.pov) === pov);
      c.setAttribute('aria-selected', String(Number(c.dataset.pov) === pov));
    });
    const a = q<HTMLElement>('[data-act=first], [data-act=prevkey]');
    const b = q<HTMLElement>('[data-act=last], [data-act=nextkey]');
    a.dataset.act = reviewOn() ? 'prevkey' : 'first';
    b.dataset.act = reviewOn() ? 'nextkey' : 'last';
    a.innerHTML = reviewOn() ? JUMP(true) : ENDS(true);
    b.innerHTML = reviewOn() ? JUMP(false) : ENDS(false);
    a.setAttribute('aria-label', reviewOn() ? 'Previous mistake' : 'First move');
    b.setAttribute('aria-label', reviewOn() ? 'Next mistake' : 'Last move');
    drawTicks();
    draw();
  };

  /** The frame of the previous / next key move of the side shown. */
  const keyFrame = (dir: 1 | -1) => {
    for (let i = at + dir; i >= 0 && i < frames.length; i += dir) {
      const v = verdictOf(frames[i]);
      if (v && KEY_LABELS.includes(v.label)) return i;
    }
    return -1;
  };

  /** Shows frame `to`: one step forward animates the move, anything else snaps there. */
  const go = async (to: number) => {
    to = Math.max(0, Math.min(frames.length - 1, to));
    if (busy || to === at) return;
    const f = frames[to]!;
    if (to === at + 1 && f.move && !calm()) {
      busy = true;
      at = to;
      view.showVerdict(null);
      view.markMoved([]);
      draw();
      await view.animateMove(f.move, f.state.players, 1.4);
      view.layout(f.state.players);
      ring(f);
      busy = false;
      draw();
    } else {
      at = to;
      view.layout(f.state.players);
      ring(f);
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
  let unfollow = () => {};
  const leave = () => {
    stop();
    unfollow();
  };
  el.addEventListener('click', async (e) => {
    const t = e.target as Element;
    const pv = t.closest<HTMLElement>('[data-pov]')?.dataset.pov;
    if (pv !== undefined) {
      if (!reviewOn()) return;
      pov = Number(pv);
      // A bot's side is reviewed when it's picked.
      watchReview();
      drawMode();
      return;
    }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'review') {
      leave();
      opts.onReview?.(pov);
    } else if (act === 'back') {
      leave();
      onClose();
    } else if (act === 'best') {
      showBest = !showBest;
      try {
        localStorage.setItem(BEST_KEY, showBest ? '1' : '0');
      } catch {
        // Storage blocked: the choice lasts for this screen.
      }
      draw();
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
      else if (act === 'prevkey' || act === 'nextkey') {
        const i = keyFrame(act === 'prevkey' ? -1 : 1);
        if (i >= 0) await go(i);
      } else if (act === 'share') await share(rec, q('[data-act=share] span'));
    }
  });
  scrub.addEventListener('input', () => {
    stop();
    void go(Number(scrub.value));
  });

  // The review as it comes in (it may still be running in the queue).
  const take = (p: ReviewProgress) => {
    const old = p.old && !p.finished ? p.old : null;
    moves = old ? old.moves : p.moves;
    luck = old ? old.luck : p.luck;
    chances = p.chances ?? chances;
    drawMode();
  };
  const watchReview = () => {
    unfollow();
    if (!people.length) return;
    unfollow = follow(rec, take, { keep: opts.keep ?? true, who: [pov], open: !people.includes(pov) });
  };
  watchReview();

  drawMode();
  if (error) q('.rpcount').textContent = error;
  // Opened at a reviewed move or roll: show the position before the move, then play it.
  const f = opts.startAt === undefined ? -1 : frames.findIndex((x) => x.at > opts.startAt!);
  if (f > 0) {
    if (opts.startCaption) notes.set(f, opts.startCaption);
    at = f - 1;
    view.layout(frames[at]!.state.players);
    ring(frames[at]!);
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

/** The screen for a link that couldn't be opened: damaged, cut off, or from a different version. */
export function brokenLinkScreen(onHome: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'screen replay broken';
  el.innerHTML = `<div class="rpbroken"><h2 class="disp">This link is broken</h2><p class="sub">The game in it couldn't be opened. It may be cut off, or from a different version of the game.</p>
    <button class="b3 green disp" data-act="home">PLAY LUDO</button></div>`;
  el.querySelector('[data-act=home]')!.addEventListener('click', onHome);
  return el;
}
