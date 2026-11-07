// Friends (#209, a first version), plain on purpose (the design comes later from ludo-uiux): the Friends sheet
// (your code, add a friend by code, your friends with who's online, and Invite when you're in a room), and the
// invite that pops up wherever you are (Join or Decline). Online play only: the terms first (#208).
import { copyWithFeedback } from './clipboard';
import { icons } from './art';
import { friendsLink, onFriendsStart, startFriends, type FriendsLink } from '../net/friends';
import type { Friend, FriendRequest } from '../net/protocol';
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
    <div class="fmine"><span>Your friend code</span><div class="fcrow"><button class="fcode" type="button" data-act="copycode" aria-label="Your friend code. Tap to copy"><b class="disp">…</b><small aria-live="polite">Tap to copy</small></button><button class="rbtn cpbtn" type="button" data-act="copycode" aria-label="Copy your friend code">${icons.copy}</button><button class="rbtn shbtn" type="button" data-act="sharecode" aria-label="Share your friend code">${icons.share}</button></div></div>
    <form class="fadd"><input maxlength="6" placeholder="Friend's code" aria-label="Friend's code" autocomplete="off" autocapitalize="characters" spellcheck="false"><button class="b3 green disp" type="submit">ADD</button></form>
    <p class="ferr" role="alert" hidden></p><p class="fsent" role="status" hidden></p>
    <div class="freqs" hidden></div>
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
  // #237: requests to you (Accept, or × to decline), newest first; and how many of yours wait for an answer.
  const req = (r: FriendRequest) =>
    `<div class="frow freq"><span class="fwho"><b>${esc(r.name)}</b><small>Wants to be friends</small></span><button class="facc" data-accept="${r.id}" aria-label="Accept ${esc(r.name)}">Accept</button><button class="frem" data-decline="${r.id}" aria-label="Decline ${esc(r.name)}">×</button></div>`;
  const draw = () => {
    ov.querySelector('.fmine b')!.textContent = link.code || '…';
    const reqs = ov.querySelector<HTMLElement>('.freqs')!;
    reqs.hidden = !link.requests.length;
    reqs.innerHTML = link.requests.length ? `<h3>Requests <em>${link.requests.length}</em></h3>${link.requests.map(req).join('')}` : '';
    const sent = ov.querySelector<HTMLElement>('.fsent')!;
    sent.hidden = !link.out;
    sent.textContent = link.out ? `${link.out} sent, waiting for an answer` : '';
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
      copyWithFeedback(link.code, ov.querySelector('.fmine .cpbtn'), ov.querySelector('.fcode small'), 'Tap to copy', icons);
      return;
    }
    if (t.closest('[data-act=sharecode]') && link.code) {
      const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
      const text = `Add me as a friend in Tag Team Ludo. My friend code: ${link.code}`;
      if (nav.share) void nav.share({ text }).catch(() => undefined);
      else copyWithFeedback(link.code, ov.querySelector('.fmine .cpbtn'), ov.querySelector('.fcode small'), 'Tap to copy', icons);
      return;
    }
    const acc = t.closest<HTMLElement>('[data-accept]')?.dataset.accept;
    const dec = t.closest<HTMLElement>('[data-decline]')?.dataset.decline;
    if (acc || dec) {
      sfx.tick();
      link.answer((acc ?? dec)!, !!acc);
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
    input.placeholder = 'Request sent';
    setTimeout(() => (input.placeholder = "Friend's code"), 2400);
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

/**
 * #237: a friend request while the app is open: a small card at the top ("Riya wants to be friends", Accept or
 * Later), one at a time, gone after 8 s. The request stays in the Friends sheet either way.
 */
export function watchRequests(stage: HTMLElement): () => void {
  let off = () => {};
  const stop = onFriendsStart((link) => {
    off = link.on((m) => {
      if (m.t !== 'request') return;
      stage.querySelector('.freq-ov')?.remove();
      const card = document.createElement('div');
      card.className = 'freq-ov';
      card.setAttribute('role', 'alertdialog');
      card.setAttribute('aria-label', `${m.from.name} wants to be friends`);
      card.innerHTML = `<span class="fi" aria-hidden="true">${icons.friends}</span><span class="ft"><b>${esc(m.from.name)}</b><small>wants to be friends</small></span>
        <button class="facc" data-act="accept">Accept</button><button class="flater" data-act="later">Later</button>`;
      const close = () => card.remove();
      const timer = setTimeout(close, 8000);
      card.addEventListener('click', (e) => {
        const act = (e.target as Element).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (!act) return;
        clearTimeout(timer);
        sfx.tick();
        if (act === 'accept') link.answer(m.from.id, true);
        close();
      });
      stage.appendChild(card);
    });
  });
  return () => {
    stop();
    off();
  };
}
