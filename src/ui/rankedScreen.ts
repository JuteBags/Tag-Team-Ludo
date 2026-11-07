// Ranked PvP: your tier in each mode, then the search. The queue matches people of a similar rating (the
// window widens while you wait) and after a minute fills empty places with ranked bots at your rating. A match
// is a room that has already started: the usual game screen with a RoomLink, rated when it ends.
import { icons } from './art';
import { RoomLink, roomsUrl } from '../net/client';
import { GAME_MODES, MODE_LABEL, MODE_NOTE, type AccountReply, type GameMode } from '../net/protocol';
import { QueueLink, loadAccount } from '../net/ranked';
import { PROVISIONAL, SEARCH_HINT_MS, tierOf } from '../net/rating';
import { requireTerms } from './legal';
import { onlineConfig } from './onlineScreen';
import { saveSetting, settings } from './settings';
import { NAME_MAX, cleanName, type GameConfig } from './setup';
import { sfx } from './sfx';

/** A tier's colour, for its badge. */
export const TIER_COLOR: Record<string, string> = { Bronze: '#d08a4a', Silver: '#c9d3e6', Gold: '#ffd23f', Platinum: '#5fe3d0', Diamond: '#9fc2ff' };
/** "Gold II · 62 pts", or "Placement 3/10" for someone's first PROVISIONAL games in a mode (#216). */
export const tierText = (rating: number, games = PROVISIONAL) => {
  if (games < PROVISIONAL) return `Placement ${games}/${PROVISIONAL}`;
  const t = tierOf(rating);
  return `${t.label} · ${t.points} pts`;
};
const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function rankedScreen(onGame: (link: RoomLink, cfg: GameConfig) => void, onBack: () => void, onPrivate?: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'screen setup online ranked';
  el.innerHTML = `
    <div class="gtop"><button class="rbtn" data-act="back" aria-label="Back">${icons.back}</button>
      <div class="mode"><small>ONLINE</small><b>RANKED PVP</b></div><span class="rbtn-space"></span></div>
    <section class="wiz" data-step="modes">
      <h3 class="disp">Ranked</h3><p class="sub who">Loading your ranks…</p>
      <label class="rname"><span>Your name</span><input class="namein" maxlength="${NAME_MAX}" autocomplete="nickname" spellcheck="false" placeholder="Your name"></label>
      <div class="rmodes"></div>
      <p class="oerr" role="alert" hidden></p>
      <p class="rnote">Matched with players near your rank. Leaving a game forfeits: it counts as last place.</p>
    </section>
    <section class="wiz" data-step="search" hidden>
      <h3 class="disp smode"></h3><p class="sub stier"></p>
      <div class="mid"><div class="sp search">
        <div class="spin" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <b class="selapsed">0:00</b>
        <p class="sline"></p>
        <button class="shint" data-act="private" hidden><span>Taking too long? Play with friends in a private room.</span></button>
      </div></div>
      <button class="b3 blue disp go" data-act="cancel">CANCEL</button>
    </section>`;
  const $ = <T extends HTMLElement>(q: string) => el.querySelector<T>(q)!;
  const nameIn = $<HTMLInputElement>('.namein');
  nameIn.value = settings.myName;
  /** The name others see in your games (kept like the private room's, in Settings' name). */
  const myName = () => cleanName(nameIn.value, 'Player');
  // No redraw here: the change fires as the field loses focus, which is often the tap on PLAY itself, and
  // redrawing the cards would swallow that tap.
  nameIn.addEventListener('change', () => {
    saveSetting('myName', nameIn.value.trim() ? myName() : '');
    if (account) account.name = myName();
  });
  let account: AccountReply | null = null;
  let queue: QueueLink | null = null;
  let link: RoomLink | null = null;
  let started = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const show = (step: 'modes' | 'search') => el.querySelectorAll<HTMLElement>('.wiz').forEach((w) => (w.hidden = w.dataset.step !== step));
  const error = (text: string) => {
    const p = $('.oerr');
    p.textContent = text;
    p.hidden = !text;
  };

  const drawModes = () => {
    if (!account) return;
    $('.who').textContent = 'Guest account on this phone';
    $('.rmodes').innerHTML = GAME_MODES.map((m) => {
      const r = account!.ratings[m];
      const t = tierOf(r.rating);
      return `<button class="rmode" data-mode="${m}" style="--tc:${TIER_COLOR[t.tier]}">
        <span class="rbadge disp">${t.tier[0]}${t.division ? `<small>${t.division}</small>` : ''}</span>
        <span class="rtxt"><b class="disp">${MODE_LABEL[m]}</b><small>${MODE_NOTE[m]}</small><em>${tierText(r.rating, r.games)}${r.games ? ` · ${r.wins}/${r.games} won` : ''}</em></span>
        <span class="rplay disp">PLAY</span></button>`;
    }).join('');
  };

  const load = async () => {
    if (!roomsUrl()) return error('Online play isn’t set up in this version of the app.');
    // Nothing goes to the server (not even the guest account) until the terms are accepted (#208).
    if (!(await requireTerms(el))) return error('Online play needs your OK to Privacy & Terms.');
    try {
      account = await loadAccount(myName());
      error('');
      drawModes();
    } catch {
      $('.who').textContent = '';
      error('Couldn’t reach the ranked server. Check your connection and try again.');
    }
  };

  const stopSearch = () => {
    clearInterval(timer);
    queue?.cancel();
    queue = null;
  };

  const search = (mode: GameMode) => {
    if (!account) return;
    error('');
    show('search');
    $('.smode').textContent = MODE_LABEL[mode];
    $('.stier').textContent = tierText(account.ratings[mode].rating, account.ratings[mode].games);
    $('.sline').textContent = 'Finding players near your rank…';
    $<HTMLElement>('.shint').hidden = true;
    started = performance.now();
    timer = setInterval(() => {
      const waited = performance.now() - started;
      $('.selapsed').textContent = clock(waited);
      // After a while, a hint: friends in a private room (#216). Cancel stays right below.
      if (onPrivate && waited >= SEARCH_HINT_MS) $<HTMLElement>('.shint').hidden = false;
    }, 250);
    const q = new QueueLink(mode, account, myName());
    queue = q;
    q.on((m) => {
      if (queue !== q) return;
      if (m.t === 'search') {
        // No "N searching": alone, "1 searching" followed by a match would give the bot fill away (#218 review).
        $('.sline').textContent = `Within ${m.window} rating of you`;
      } else if (m.t === 'matched') {
        sfx.tick();
        clearInterval(timer);
        queue = null;
        $('.sline').textContent = 'Match found! Joining…';
        $<HTMLElement>('.shint').hidden = true;
        const l = RoomLink.join(m.code, myName(), m.token);
        link = l;
        const off = l.on((x) => {
          if (x.t === 'game') {
            off();
            link = null;
            onGame(l, onlineConfig(x.setup));
          } else if (x.t === 'error' && l.fatal) {
            off();
            link = null;
            show('modes');
            error(l.fatal.message);
          }
        });
      } else if (m.t === 'error' || m.t === 'closed') {
        stopSearch();
        show('modes');
        error(m.t === 'error' ? m.message : 'The connection dropped. Tap a mode to search again.');
      }
    });
  };

  el.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-act], [data-mode]');
    if (!b) return;
    if (b.dataset.mode) {
      sfx.tick();
      return search(b.dataset.mode as GameMode);
    }
    if (b.dataset.act === 'private') {
      // The hint: stop searching and play with friends instead.
      stopSearch();
      link?.close();
      link = null;
      onPrivate?.();
      return;
    }
    if (b.dataset.act === 'cancel') {
      stopSearch();
      link?.close();
      link = null;
      show('modes');
      return;
    }
    if (b.dataset.act === 'back') {
      if (queue || link) {
        stopSearch();
        link?.close();
        link = null;
        return show('modes');
      }
      onBack();
    }
  });
  // Leaving the screen any other way ends the search.
  const watch = setInterval(() => {
    if (el.isConnected) return;
    stopSearch();
    clearInterval(watch);
  }, 1000);
  void load();
  return el;
}
