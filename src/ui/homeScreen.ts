import { COLORS, type PlayerState } from '../engine';
import { PALETTE, icons, pawnSVG } from './art';
import { BoardView } from './boardView';
import { dieMarkup } from './dice';
import { settings } from './settings';
import type { Mode } from './setup';
import { settingsSheet, statsSheet, symbolRow } from './sheets';
import type { SavedGame } from './store';
import { setSymbols } from './themes';

/** "just now", "12 min ago", "3 h ago", "2 days ago": when a saved game was last played. */
function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} day${h < 36 ? '' : 's'} ago`;
}

/** Decorative board on the home screen (blue pair on a star). */
const HERO: PlayerState[] = [
  { color: 'blue', owner: 0, bot: false, tokens: [8, 8, -1, -1] },
  { color: 'green', owner: 1, bot: true, tokens: [3, -1, -1, -1] },
  { color: 'red', owner: 2, bot: true, tokens: [17, -1, -1, -1] },
  { color: 'yellow', owner: 3, bot: true, tokens: [29, -1, -1, -1] },
];

export function homeScreen(count: 2 | 3 | 4, onCount: (n: 2 | 3 | 4) => void, onPlay: (mode: Mode) => void, saved: SavedGame | null, onContinue: () => void, onStore: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = `screen home${saved ? ' has-save' : ''}`;
  const dots = (n: number) => COLORS.slice(0, n).map((c) => `<i style="background:${PALETTE[c].m}"></i>`).join('');
  const people = saved ? saved.config.names.length : 0;
  el.innerHTML = `
    <button class="rbtn corner l" data-act="stats" aria-label="Stats">${icons.stats}<small>Stats</small></button>
    <button class="rbtn corner r" data-act="settings" aria-label="Settings">${icons.gear}<small>Settings</small></button>
    <h1 class="logo disp"><small data-t="TAG TEAM"><span>TAG TEAM</span></small><b data-t="LUDO"><span>LUDO</span></b></h1>
    <div class="hero"><div class="glow"></div><div class="tilt"></div>
      <div class="hdie">${dieMarkup(6, 50, -26, -34)}</div><div class="hdie2">${dieMarkup(3, 38, -20, 24)}</div></div>
    ${saved ? `<button class="cont" data-act="continue"><span class="pi">${icons.play}</span><b class="disp">CONTINUE GAME</b><small>${saved.config.mode === 'pvp' ? 'With friends' : 'vs Computer'} · ${people} players · ${ago(saved.savedAt)}</small></button>` : ''}
    <div class="seg"><span class="lbl">Players</span>${([2, 3, 4] as const).map((n) => `<button class="o${n === count ? ' on' : ''}" data-n="${n}"><span class="dots">${dots(n)}</span>${n} Players</button>`).join('')}</div>
    <div class="modes">
      <button class="mcard pvc" data-mode="pvc"><span class="ci">${icons.robot}</span><b class="disp">VS COMPUTER</b><small>You against bots</small></button>
      <button class="mcard pvp" data-mode="pvp"><span class="ci">${icons.friends}</span><b class="disp">WITH FRIENDS</b><small>Pass the phone</small></button>
    </div>
    <button class="storerow" data-act="store"><span class="sp3">${pawnSVG('blue')}${pawnSVG('red')}${pawnSVG('yellow')}</span><span><b class="disp">STORE</b><small>Pawns, dice, throwers and boards</small></span><em>New</em></button>
    <button class="cbrow" data-act="symbols" role="switch" aria-checked="${settings.symbols}"><span>Colour-blind symbols</span>${symbolRow()}<em class="swl">${settings.symbols ? 'On' : 'Off'}</em><i class="sw"></i></button>
    <div class="foot">Both modes play offline · Online play and private rooms coming soon · v${__APP_VERSION__}<small>Avatars: Fun Emoji by Davis Uche, CC BY 4.0</small></div>`;
  el.querySelector('.tilt')!.appendChild(new BoardView(HERO, 286).el);
  el.querySelectorAll<HTMLElement>('.mcard').forEach((b) => b.addEventListener('click', () => onPlay(b.dataset.mode as Mode)));
  el.querySelectorAll<HTMLButtonElement>('.seg .o').forEach((b) =>
    b.addEventListener('click', () => {
      el.querySelectorAll('.seg .o').forEach((x) => x.classList.toggle('on', x === b));
      onCount(Number(b.dataset.n) as 2 | 3 | 4);
    }),
  );
  // The colour-blind switch is right on the home screen, so it's easy to find.
  const cb = el.querySelector<HTMLElement>('.cbrow')!;
  const sync = () => {
    cb.setAttribute('aria-checked', String(settings.symbols));
    cb.querySelector('.swl')!.textContent = settings.symbols ? 'On' : 'Off';
  };
  cb.addEventListener('click', () => {
    setSymbols(!settings.symbols);
    sync();
  });
  el.querySelector('[data-act=continue]')?.addEventListener('click', onContinue);
  el.querySelector('[data-act=store]')!.addEventListener('click', onStore);
  el.querySelector('[data-act=stats]')!.addEventListener('click', () => void statsSheet(el));
  el.querySelector('[data-act=settings]')!.addEventListener('click', () => settingsSheet(el, sync));
  return el;
}
