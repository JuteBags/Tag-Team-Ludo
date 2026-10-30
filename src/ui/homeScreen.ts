import { COLORS, type PlayerState } from '../engine';
import { PALETTE, icons } from './art';
import { BoardView } from './boardView';
import { dieMarkup } from './dice';
import type { Mode } from './setup';

/** Decorative board on the home screen (blue pair on a star). */
const HERO: PlayerState[] = [
  { color: 'blue', owner: 0, bot: false, tokens: [8, 8, -1, -1] },
  { color: 'green', owner: 1, bot: true, tokens: [3, -1, -1, -1] },
  { color: 'red', owner: 2, bot: true, tokens: [17, -1, -1, -1] },
  { color: 'yellow', owner: 3, bot: true, tokens: [29, -1, -1, -1] },
];

export function homeScreen(count: 2 | 3 | 4, onCount: (n: 2 | 3 | 4) => void, onPlay: (mode: Mode) => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'screen home';
  const dots = (n: number) => COLORS.slice(0, n).map((c) => `<i style="background:${PALETTE[c].m}"></i>`).join('');
  el.innerHTML = `
    <h1 class="logo disp"><small data-t="TAG TEAM"><span>TAG TEAM</span></small><b data-t="LUDO"><span>LUDO</span></b></h1>
    <div class="hero"><div class="glow"></div><div class="tilt"></div>
      <div class="hdie">${dieMarkup(6, 50, -26, -34)}</div><div class="hdie2">${dieMarkup(3, 38, -20, 24)}</div></div>
    <div class="modes">
      <button class="mcard pvc" data-mode="pvc"><span class="ci">${icons.robot}</span><b class="disp">VS COMPUTER</b><small>You against bots</small></button>
      <button class="mcard pvp" data-mode="pvp"><span class="ci">${icons.friends}</span><b class="disp">WITH FRIENDS</b><small>Pass the phone</small></button>
    </div>
    <div class="seg"><span class="lbl">Players</span>${([2, 3, 4] as const).map((n) => `<button class="o${n === count ? ' on' : ''}" data-n="${n}"><span class="dots">${dots(n)}</span>${n} Players</button>`).join('')}</div>
    <div class="tiles">
      <div class="tile on locked"><span class="soon">COMING SOON</span><span class="ic">${icons.globe}</span><b class="disp">ONLINE</b><small>Play the world</small><span class="lk">${icons.lock}</span></div>
      <div class="tile pr locked"><span class="soon">COMING SOON</span><span class="ic">${icons.friends}</span><b class="disp">PRIVATE</b><small>Room with friends</small><span class="lk">${icons.lock}</span></div>
    </div>
    <div class="foot">Both modes play offline · v${__APP_VERSION__}</div>`;
  el.querySelector('.tilt')!.appendChild(new BoardView(HERO, 286).el);
  el.querySelectorAll<HTMLElement>('.mcard').forEach((b) => b.addEventListener('click', () => onPlay(b.dataset.mode as Mode)));
  el.querySelectorAll<HTMLButtonElement>('.seg .o').forEach((b) =>
    b.addEventListener('click', () => {
      el.querySelectorAll('.seg .o').forEach((x) => x.classList.toggle('on', x === b));
      onCount(Number(b.dataset.n) as 2 | 3 | 4);
    }),
  );
  return el;
}
