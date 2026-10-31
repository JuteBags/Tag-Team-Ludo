// Pop-up sheets on the home screen: Settings and Stats. Back (or the close button) dismisses them.
import { COLORS } from '../engine';
import { PALETTE, symbolPath } from './art';
import { saveSetting, settings } from './settings';
import { sfx } from './sfx';
import { EMPTY_STATS, loadStats, resetStats, type Stats } from './store';
import { THEMES, setSymbols, setTheme } from './themes';

function sheet(host: HTMLElement, title: string, body: string): HTMLElement {
  const ov = document.createElement('div');
  ov.className = 'menu-ov sheet';
  ov.innerHTML = `<div class="box"><h2>${title}</h2>${body}<button class="b3 green disp" data-act="close">DONE</button></div>`;
  ov.addEventListener('click', (e) => {
    if (e.target === ov || (e.target as Element).closest('[data-act=close]')) ov.remove();
  });
  host.appendChild(ov);
  return ov;
}

/** The four colour-blind symbols, in their colours, for labels. */
export const symbolRow = () =>
  `<svg class="syms" viewBox="0 0 64 16" aria-hidden="true">${COLORS.map((c, i) => `<path d="${symbolPath(c, 5.5)}" transform="translate(${8 + i * 16} 8)" fill="${PALETTE[c].m}" stroke="#fff" stroke-width="1"/>`).join('')}</svg>`;

/** Wires a two-way toggle group (`.tg[data-k]`) to a setter. */
function toggle(ov: HTMLElement, key: string, set: (v: string) => void) {
  const tg = ov.querySelector<HTMLElement>(`.tg[data-k=${key}]`)!;
  tg.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button');
    if (!b) return;
    tg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    set(b.dataset.v!);
  });
}

const tg = (key: string, options: [string, string, boolean][]) =>
  `<div class="tg" data-k="${key}">${options.map(([v, label, on]) => `<button class="${on ? 'on' : ''}" data-v="${v}">${label}</button>`).join('')}</div>`;

export function settingsSheet(host: HTMLElement, changed: () => void) {
  const ov = sheet(
    host,
    'Settings',
    `<div class="set"><span>Board</span><div class="themes">${THEMES.map((t) => `<button class="th${t.id === settings.theme ? ' on' : ''}" data-t="${t.id}"><i style="background:${t.swatch}"></i>${t.name}</button>`).join('')}</div></div>
    <div class="set"><span>Colour-blind symbols ${symbolRow()}</span>${tg('sym', [['on', 'On', settings.symbols], ['off', 'Off', !settings.symbols]])}</div>
    <div class="set"><span>Dice counts the</span>${tg('face', [['top', 'Top face', settings.diceFace === 'top'], ['front', 'Front face', settings.diceFace === 'front']])}</div>
    <div class="set"><span>Sound</span>${tg('sound', [['on', 'On', !sfx.muted], ['off', 'Off', sfx.muted]])}</div>`,
  );
  ov.querySelector('.themes')!.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('.th');
    if (!b) return;
    ov.querySelectorAll('.th').forEach((x) => x.classList.toggle('on', x === b));
    setTheme(b.dataset.t as (typeof THEMES)[number]['id']);
  });
  toggle(ov, 'sym', (v) => {
    setSymbols(v === 'on');
    changed();
  });
  toggle(ov, 'face', (v) => saveSetting('diceFace', v as 'top' | 'front'));
  toggle(ov, 'sound', (v) => sfx.setMuted(v === 'off'));
}

export async function statsSheet(host: HTMLElement) {
  const s: Stats = await loadStats().catch(() => ({ ...EMPTY_STATS }));
  const rate = s.played ? `${Math.round((100 * s.wins) / s.played)}%` : '–';
  const best = s.best ? ['', '1st', '2nd', '3rd', '4th'][s.best]! : '–';
  const cell = (v: string | number, label: string) => `<div class="st"><b class="disp">${v}</b><small>${label}</small></div>`;
  const ov = sheet(
    host,
    'Your stats',
    `<p class="sub">vs Computer, on this device</p>
    <div class="stats">${cell(s.played, 'Games')}${cell(s.wins, 'Wins')}${cell(rate, 'Win rate')}${cell(best, 'Best place')}${cell(s.kills, 'Kills')}${cell(s.pairs, 'Pairs formed')}</div>
    <p class="sub">With friends: ${s.friends} game${s.friends === 1 ? '' : 's'}</p>
    <button class="reset" data-act="reset">Reset stats</button>`,
  );
  const reset = ov.querySelector<HTMLButtonElement>('[data-act=reset]')!;
  reset.addEventListener('click', async () => {
    // Two taps, so stats aren't wiped by accident.
    if (!reset.classList.contains('sure')) {
      reset.classList.add('sure');
      reset.textContent = 'Tap again to reset';
      return;
    }
    await resetStats();
    ov.remove();
    void statsSheet(host);
  });
}
