// Friends (#209, a first version), plain on purpose (the design comes later from ludo-uiux): the Friends sheet
// (your code, add a friend by code, your friends with who's online, and Invite when you're in a room), and the
// invite that pops up wherever you are (Join or Decline). Online play only: the terms first (#208).
import { copyText } from './clipboard';
import { friendsLink, onFriendsStart, startFriends, type FriendsLink } from '../net/friends';
import type { Friend } from '../net/protocol';
import { requireTerms } from './legal';
import { settings } from './settings';
import { sfx } from './sfx';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const myName = () => settings.myName?.trim() || 'Player';

/**
 * The Friends sheet over `host`. `room`: the private room you're in (its friends who are online can be invited).
 * Asks for the terms and makes the guest account first, if need be.
 */
export async function friendsSheet(host: HTMLElement, room?: string): Promise<void> {
  if (!(await requireTerms(host))) return;
  const ov = document.createElement('div');
  ov.className = 'menu-ov sheet friends';
  ov.innerHTML = `<div class="box"><button class="x" data-act="close" aria-label="Close">×</button><h2>Friends</h2>
    <p class="fmine">Your friend code<button class="fcode" type="button" data-act="copycode" aria-label="Your friend code. Tap to copy"><b class="disp">…</b><small>Tap to copy</small></button></p>
    <form class="fadd"><input maxlength="6" placeholder="Friend's code" aria-label="Friend's code" autocomplete="off" autocapitalize="characters" spellcheck="false"><button class="b3 green disp" type="submit">ADD</button></form>
    <p class="ferr" role="alert" hidden></p>
    <div class="flist"></div>
    <button class="b3 blue disp" data-act="close">DONE</button></div>`;
  host.appendChild(ov);
  const err = (text: string) => {
    const e = ov.querySelector<HTMLElement>('.ferr')!;
    e.textContent = text;
    e.hidden = !text;
  };
  let link: FriendsLink;
  try {
    link = await startFriends(myName());
  } catch {
    err('Couldn’t reach the server. Check your connection and try again.');
    return;
  }
  const invited = new Map<string, string>();
  const row = (f: Friend) =>
    `<div class="frow${f.online ? ' online' : ''}"><i class="fdot${f.online ? ' on' : ''}" aria-hidden="true"></i><span class="fwho"><b>${esc(f.name)}</b><small>${f.online ? 'Online' : 'Offline'}</small></span>${
      room && f.online ? `<button class="finv" data-invite="${f.id}"${invited.has(f.id) ? ' disabled' : ''}>${esc(invited.get(f.id) ?? 'Invite')}</button>` : ''
    }<button class="frem" data-remove="${f.id}" aria-label="Remove ${esc(f.name)}">×</button></div>`;
  const draw = () => {
    ov.querySelector('.fmine b')!.textContent = link.code || '…';
    const list = [...link.friends].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    ov.querySelector('.flist')!.innerHTML = list.length ? list.map(row).join('') : '<p class="fnone">No friends yet. Swap codes with a friend and add theirs.</p>';
  };
  draw();
  const off = link.on((m) => {
    if (m.t === 'error') err(m.message);
    if (m.t === 'reply' && room && m.room === room) invited.set(m.from.id, m.accept ? 'Joining' : 'Declined');
    draw();
  });
  ov.addEventListener('click', (e) => {
    const t = e.target as Element;
    if (e.target === ov || t.closest('[data-act=close]')) {
      off();
      ov.remove();
      return;
    }
    const copy = t.closest<HTMLElement>('[data-act=copycode]');
    if (copy && link.code) {
      const hint = copy.querySelector('small')!;
      void copyText(link.code).then((ok) => {
        if (!ok) return;
        hint.textContent = 'Copied';
        setTimeout(() => (hint.textContent = 'Tap to copy'), 1600);
      });
      return;
    }
    const inv = t.closest<HTMLElement>('[data-invite]')?.dataset.invite;
    const rem = t.closest<HTMLElement>('[data-remove]')?.dataset.remove;
    if (inv && room) {
      sfx.tick();
      err('');
      link.invite(inv, room);
      invited.set(inv, 'Invited');
      draw();
    } else if (rem) {
      sfx.tick();
      link.remove(rem);
    }
  });
  ov.querySelector<HTMLFormElement>('.fadd')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = ov.querySelector<HTMLInputElement>('.fadd input')!;
    if (!input.value.trim()) return;
    err('');
    sfx.tick();
    link.add(input.value);
    input.value = '';
  });
}

/**
 * Invites from friends, wherever the app is: a small sheet over `stage` with Join and Decline. `onJoin(room)`
 * opens that private room. Starts when the friends link does.
 */
export function watchInvites(stage: HTMLElement, onJoin: (room: string) => void): () => void {
  let off = () => {};
  const stop = onFriendsStart((link) => {
    off = link.on((m) => {
      if (m.t !== 'invite') return;
      stage.querySelector('.invite-ov')?.remove();
      const ov = document.createElement('div');
      ov.className = 'menu-ov invite-ov';
      ov.innerHTML = `<div class="box"><h2>Join a room?</h2><p class="sub"><b>${esc(m.from.name)}</b> invites you to their private room <b class="disp">${esc(m.room)}</b>.</p>
        <button class="b3 green disp" data-act="join">JOIN</button><button class="later" data-act="later">Decline</button></div>`;
      ov.addEventListener('click', (e) => {
        const act = (e.target as Element).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act !== 'join' && act !== 'later') return;
        ov.remove();
        link.reply(m.from.id, m.room, act === 'join');
        if (act === 'join') onJoin(m.room);
      });
      stage.appendChild(ov);
    });
  });
  return () => {
    stop();
    off();
  };
}

/** Whether the friends link is up (for showing who's online without asking anything). */
export const friendsOn = () => !!friendsLink();
