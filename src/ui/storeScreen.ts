// The Store (#35): four shelves of skins (pawns, dice, throwers, boards). Every skin is on show; locked
// ones say how they unlock. Tap a skin to preview it, then USE it. Skins only change the look.
import { COLORS } from '../engine';
import { icons, pawnSVG } from './art';
import { BoardView } from './boardView';
import { THROWER_ART, dieMarkup, rollDie } from './dice';
import { sfx } from './sfx';
import { SHELVES, UNLOCK_ALL, buy, equip, equipped, isUnlocked, lockLabel, shelfSkins, type Shelf, type Skin } from './skins';
import { settings } from './settings';
import { THEMES, applyLook } from './themes';
import type { ThrowStyle } from './settings';

/** A board for previews: a few pawns out on the track. */
const PREVIEW = [
  { color: 'blue' as const, owner: 0, bot: false, tokens: [5, 18, -1, -1] },
  { color: 'green' as const, owner: 1, bot: true, tokens: [9, -1, -1, -1] },
  { color: 'red' as const, owner: 2, bot: true, tokens: [30, 30, -1, -1] },
  { color: 'yellow' as const, owner: 3, bot: true, tokens: [44, -1, -1, -1] },
];

/** The small picture on a skin's card. */
function thumb(s: Skin): string {
  if (s.shelf === 'pawn') return `<span class="thp">${pawnSVG('blue', s.id)}${pawnSVG('red', s.id)}</span>`;
  if (s.shelf === 'dice') return dieMarkup(6, 34, undefined, undefined, undefined, s.id);
  if (s.shelf === 'thrower') return `<span class="tht">${THROWER_ART[s.id] ?? dieMarkup(5, 30)}</span>`;
  return `<i class="thb" style="background:${THEMES.find((t) => t.id === s.id)?.swatch}"></i>`;
}

export function storeScreen(onBack: () => void): HTMLElement {
  let shelf: Shelf = 'pawn';
  let picked: Skin = equipped(shelf);
  const el = document.createElement('div');
  el.className = 'screen store';
  el.innerHTML = `
    <div class="gtop"><button class="rbtn" data-act="back" aria-label="Back">${icons.back}</button>
      <div class="mode"><small>SKINS</small><b>STORE</b></div><span class="goldpill"><i class="coin"></i><b></b></span></div>
    ${UNLOCK_ALL ? '<p class="devnote">Test build: every skin is unlocked</p>' : ''}
    <div class="tg shelves">${SHELVES.map((s) => `<button data-s="${s.id}">${s.name}</button>`).join('')}</div>
    <div class="stage"><div class="show"></div><div class="info"><b class="disp"></b><small></small></div></div>
    <div class="grid"></div>
    <button class="b3 green disp use" data-act="use"></button>`;
  const q = <T extends HTMLElement = HTMLElement>(s: string) => el.querySelector<T>(s)!;

  const draw = () => {
    el.querySelectorAll<HTMLElement>('.shelves button').forEach((b) => b.classList.toggle('on', b.dataset.s === shelf));
    const inUse = equipped(shelf);
    q('.grid').innerHTML = shelfSkins(shelf)
      .map((s) => {
        const open = isUnlocked(s);
        const label = s.unlock.kind === 'gold' ? `<i class="coin"></i>${lockLabel(s)}` : `${icons.lock}${lockLabel(s)}`;
        const state = s.id === inUse.id ? '<em class="using">In use</em>' : open ? '' : `<em class="lock">${label}</em>`;
        return `<button class="card${s.id === picked.id ? ' on' : ''}${open ? '' : ' locked'}" data-id="${s.id}">${thumb(s)}<b>${s.name}</b>${state}</button>`;
      })
      .join('');
    q('.info b').textContent = picked.name;
    q('.info small').textContent = picked.blurb;
    q('.goldpill b').textContent = String(settings.gold);
    const use = q<HTMLButtonElement>('.use');
    const open = isUnlocked(picked);
    const price = picked.unlock.kind === 'gold' ? picked.unlock.price : 0;
    const canBuy = !open && price > 0 && settings.gold >= price;
    use.disabled = (!open && !canBuy) || picked.id === inUse.id;
    use.dataset.mode = open ? 'use' : 'buy';
    use.innerHTML = open
      ? picked.id === inUse.id ? 'IN USE' : 'USE'
      : price ? `${canBuy ? 'BUY' : 'NEED'} <i class="coin"></i>${price}${canBuy ? '' : ` · YOU HAVE ${settings.gold}`}` : `LOCKED · ${lockLabel(picked).toUpperCase()}`;
    use.classList.toggle('locked', !open && !canBuy);
    preview();
  };

  /** The big preview: pawns on a board, a die, the thrower throwing, or the board itself. */
  const preview = () => {
    const show = q('.show');
    show.className = `show ${shelf}`;
    if (shelf === 'pawn') show.innerHTML = `<span class="pawns">${COLORS.map((c) => pawnSVG(c, picked.id)).join('')}</span>`;
    else if (shelf === 'dice') show.innerHTML = dieMarkup(6, 74, undefined, undefined, undefined, picked.id);
    else if (shelf === 'thrower') {
      show.innerHTML = `<button class="dbox" aria-label="Try it">${dieMarkup(6, 54)}</button><small class="try">Tap to try it</small>`;
      const box = show.querySelector<HTMLElement>('.dbox')!;
      const style = picked.id as ThrowStyle;
      const go = () => void rollDie(box, 1 + Math.floor(Math.random() * 6), 54, 1150, style);
      box.addEventListener('click', go);
      go();
    } else {
      // The board shows in its own theme while it's picked; leaving the Store puts back the one in use.
      if (picked.id === 'classic') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = picked.id;
      show.replaceChildren(new BoardView(PREVIEW, 214, ['blue']).el);
    }
  };

  q('.shelves').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('button');
    if (!b) return;
    sfx.tick();
    shelf = b.dataset.s as Shelf;
    picked = equipped(shelf);
    applyLook();
    draw();
  });
  q('.grid').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('.card');
    if (!b) return;
    sfx.tick();
    picked = shelfSkins(shelf).find((s) => s.id === b.dataset.id)!;
    draw();
  });
  q('.use').addEventListener('click', () => {
    // Buying uses it straight away.
    if (q('.use').dataset.mode === 'buy' && !buy(picked)) return;
    if (!equip(picked)) return;
    sfx.home();
    applyLook();
    draw();
  });
  q('[data-act=back]').addEventListener('click', () => {
    applyLook();
    onBack();
  });
  draw();
  return el;
}
