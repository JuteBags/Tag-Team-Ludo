// Chat in an online game (#212): a button in the top bar (in the empty right-hand slot), a short bubble for each
// line that comes in, and a sheet with the room's recent lines, quick phrases, emoji, free text (private rooms
// only), and per person Mute and Report. The server relays lines and keeps none; this screen keeps the last
// few in memory only. Plain on purpose: the fuller design comes later with ludo-uiux.
import type { RoomLink } from '../net/client';
import { CHAT_EMOJI, CHAT_MAX, QUICK_CHAT, type ServerMsg } from '../net/protocol';
import { sfx } from './sfx';

type Line = Extract<ServerMsg, { t: 'chat' }>;

const BUBBLE = `<svg viewBox="0 0 24 24"><path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-8l-5 4v-4H4A1.5 1.5 0 0 1 2.5 16V7A1.5 1.5 0 0 1 4 5.5z" fill="#fff"/></svg>`;
const KEEP = 30;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** What a line says, as text. */
export const lineText = (l: Pick<Line, 'quick' | 'emoji' | 'text'>) =>
  l.quick !== undefined ? QUICK_CHAT[l.quick] ?? '' : l.emoji !== undefined ? CHAT_EMOJI[l.emoji] ?? '' : (l.text ?? '');

/**
 * Chat on `screen` (the game screen) for `link`'s room, if its server has chat. Returns the clean-up. `slot` is
 * the element the button replaces (the top bar's empty right-hand slot).
 */
export function mountChat(screen: HTMLElement, link: RoomLink, slot: Element | null): () => void {
  if (!link.chat || !slot) return () => {};
  const lines: Line[] = [];
  const muted = new Set<number>();
  const reported = new Set<string>();
  const nameOf = (i: number) => (i === link.you ? 'You' : link.members[i]?.name || 'Player');

  const btn = document.createElement('button');
  btn.className = 'rbtn chatbtn';
  btn.dataset.act = 'chat';
  btn.setAttribute('aria-label', 'Chat');
  btn.innerHTML = `${BUBBLE}<i class="dot" hidden></i>`;
  slot.replaceWith(btn);
  const toast = document.createElement('div');
  toast.className = 'chattoast';
  toast.setAttribute('aria-live', 'polite');
  screen.appendChild(toast);

  let sheet: HTMLElement | null = null;
  const bubble = (l: Line) => {
    const b = document.createElement('div');
    b.className = 'cb';
    b.innerHTML = `<b>${esc(nameOf(l.from))}</b> <span>${esc(lineText(l))}</span>`;
    toast.appendChild(b);
    while (toast.children.length > 3) toast.firstElementChild!.remove();
    setTimeout(() => b.remove(), 4000);
  };
  const logHTML = () =>
    lines.filter((l) => !muted.has(l.from)).map((l, i) => {
      const key = `${l.at}:${l.from}`;
      const theirs = l.from !== link.you && l.text !== undefined;
      return `<div class="cl"><b>${esc(nameOf(l.from))}</b><span>${esc(lineText(l))}</span>${theirs ? `<button class="crep" data-rep="${i}"${reported.has(key) ? ' disabled' : ''}>${reported.has(key) ? 'Reported' : 'Report'}</button>` : ''}</div>`;
    }).join('') || '<p class="cnone">No messages yet.</p>';
  const peopleHTML = () =>
    link.members.map((m, i) => (i === link.you ? '' : `<button class="cmute${muted.has(i) ? ' on' : ''}" data-mute="${i}">${muted.has(i) ? 'Unmute' : 'Mute'} ${esc(m.name)}</button>`)).join('');
  const draw = () => {
    if (!sheet) return;
    const log = sheet.querySelector<HTMLElement>('.clog')!;
    log.innerHTML = logHTML();
    log.scrollTop = log.scrollHeight;
    sheet.querySelector('.cpeople')!.innerHTML = peopleHTML();
  };
  const open = () => {
    btn.querySelector<HTMLElement>('.dot')!.hidden = true;
    sheet = document.createElement('div');
    sheet.className = 'menu-ov sheet chat';
    sheet.innerHTML = `<div class="box"><button class="x" data-act="close" aria-label="Close">×</button><h2>Chat</h2>
      <div class="clog"></div>
      <div class="cquick">${QUICK_CHAT.map((q, i) => `<button data-quick="${i}">${esc(q)}</button>`).join('')}</div>
      <div class="cemoji">${CHAT_EMOJI.map((e, i) => `<button data-emoji="${i}" aria-label="${e}">${e}</button>`).join('')}</div>
      ${link.chat!.text ? `<form class="ctext"><input maxlength="${CHAT_MAX}" placeholder="Say something" aria-label="Message" autocomplete="off"><button class="b3 green disp" type="submit">SEND</button></form>` : ''}
      <div class="cpeople"></div>
      <button class="b3 blue disp" data-act="close">DONE</button></div>`;
    const s = sheet;
    s.addEventListener('click', (e) => {
      const t = e.target as Element;
      if (e.target === s || t.closest('[data-act=close]')) {
        s.remove();
        sheet = null;
        return;
      }
      const q = t.closest<HTMLElement>('[data-quick]')?.dataset.quick;
      const em = t.closest<HTMLElement>('[data-emoji]')?.dataset.emoji;
      const mu = t.closest<HTMLElement>('[data-mute]')?.dataset.mute;
      const rep = t.closest<HTMLElement>('[data-rep]')?.dataset.rep;
      if (q !== undefined) link.say({ quick: Number(q) });
      else if (em !== undefined) link.say({ emoji: Number(em) });
      else if (mu !== undefined) {
        const i = Number(mu);
        if (muted.has(i)) muted.delete(i);
        else muted.add(i);
        draw();
      } else if (rep !== undefined) {
        const l = lines.filter((x) => !muted.has(x.from))[Number(rep)];
        if (l && l.text !== undefined) {
          link.report(l.from, l.text);
          reported.add(`${l.at}:${l.from}`);
          draw();
        }
      } else return;
      sfx.tick();
    });
    s.querySelector<HTMLFormElement>('.ctext')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = s.querySelector<HTMLInputElement>('.ctext input')!;
      const text = input.value.trim();
      if (!text) return;
      link.say({ text });
      input.value = '';
    });
    screen.appendChild(s);
    draw();
  };
  btn.addEventListener('click', () => {
    sfx.tick();
    open();
  });
  const off = link.on((m) => {
    if (m.t !== 'chat') return;
    lines.push(m);
    while (lines.length > KEEP) lines.shift();
    if (muted.has(m.from)) return;
    if (sheet) draw();
    else {
      bubble(m);
      if (m.from !== link.you) btn.querySelector<HTMLElement>('.dot')!.hidden = false;
    }
  });
  return () => {
    off();
    toast.remove();
    sheet?.remove();
  };
}
