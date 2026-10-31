// Pop-up sheets on the home screen: Settings and Stats. Back (or the close button) dismisses them.
import { COLORS } from '../engine';
import { PALETTE, symbolPath } from './art';
import { saveSetting, settings } from './settings';
import { sfx } from './sfx';
import { EMPTY_STATS, loadStats, resetStats, type Stats } from './store';
import { THEMES, setSymbols, setTheme, usableThemes } from './themes';

function sheet(host: HTMLElement, title: string, body: string): HTMLElement {
  const ov = document.createElement('div');
  ov.className = 'menu-ov sheet';
  ov.innerHTML = `<div class="box"><button class="x" data-act="close" aria-label="Close">×</button><h2>${title}</h2>${body}<button class="b3 green disp" data-act="close">DONE</button></div>`;
  ov.addEventListener('click', (e) => {
    if (e.target === ov || (e.target as Element).closest('[data-act=close]')) ov.remove();
  });
  host.appendChild(ov);
  return ov;
}

/** The four colour-blind symbols, in their colours, for labels. */
export const symbolRow = () =>
  `<svg class="syms" viewBox="0 0 64 16" aria-hidden="true">${COLORS.map((c, i) => `<path d="${symbolPath(c, 5.5)}" transform="translate(${8 + i * 16} 8)" fill="${PALETTE[c].m}" stroke="#fff" stroke-width="1"/>`).join('')}</svg>`;

/** An on/off switch row, the same switch as on the home screen. */
const sw = (key: string, label: string, on: boolean) =>
  `<button class="swrow" data-k="${key}" role="switch" aria-checked="${on}"><span>${label}</span><em class="swl">${on ? 'On' : 'Off'}</em><i class="sw"></i></button>`;

/** Wires a switch row to a setter; the row flips and reports its new state. */
function switchRow(ov: HTMLElement, key: string, set: (on: boolean) => void) {
  const b = ov.querySelector<HTMLElement>(`.swrow[data-k=${key}]`)!;
  b.addEventListener('click', () => {
    const on = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(on));
    b.querySelector('.swl')!.textContent = on ? 'On' : 'Off';
    set(on);
  });
}

/** A tiny die with the counted face lit, for the dice-face choice. */
const faceIcon = (top: boolean) =>
  `<svg viewBox="0 0 28 28" aria-hidden="true"><path d="M14 3 L25 8.5 L14 14 L3 8.5Z" fill="${top ? '#ffd65a' : 'rgba(255,255,255,.35)'}"/><path d="M3 8.5 L14 14 L14 25 L3 19.5Z" fill="${top ? 'rgba(255,255,255,.35)' : '#ffd65a'}"/><path d="M25 8.5 L14 14 L14 25 L25 19.5Z" fill="rgba(255,255,255,.2)"/></svg>`;

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

/** What the Doubles setting means, under its switch. It applies to new games. */
const DOUBLES_HINT = {
  true: 'Two of your tokens on one square are a double: they move together and block. New games.',
  false: 'Classic Ludo: every token moves alone and nothing blocks. New games.',
};

export function settingsSheet(host: HTMLElement, changed: () => void) {
  const ov = sheet(
    host,
    'Settings',
    `<div class="set"><span>Board</span><div class="themes">${usableThemes().map((t) => `<button class="th${t.id === settings.theme ? ' on' : ''}" data-t="${t.id}"><i style="background:${t.swatch}"></i>${t.name}</button>`).join('')}</div></div>
    <div class="set">${sw('doubles', 'Doubles', settings.doubles)}<small class="qh">${DOUBLES_HINT[String(settings.doubles) as 'true' | 'false']}</small></div>
    <div class="set">${sw('sym', `Colour-blind symbols ${symbolRow()}`, settings.symbols)}</div>
    <div class="set"><span>Which face of the die counts?</span>${tg('face', [['top', `${faceIcon(true)}The top`, settings.diceFace === 'top'], ['front', `${faceIcon(false)}The front`, settings.diceFace === 'front']])}</div>
    <div class="set">${sw('sound', 'Sound', !sfx.muted)}</div>
    <div class="set">${sw('fast', 'Fast bots', settings.fastBots)}<small class="qh">Bots roll and move twice as fast</small></div>`,
  );
  ov.querySelector('.themes')!.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('.th');
    if (!b) return;
    ov.querySelectorAll('.th').forEach((x) => x.classList.toggle('on', x === b));
    setTheme(b.dataset.t as (typeof THEMES)[number]['id']);
  });
  switchRow(ov, 'sym', (on) => {
    setSymbols(on);
    changed();
  });
  switchRow(ov, 'doubles', (on) => {
    saveSetting('doubles', on);
    ov.querySelector('.set .qh')!.textContent = DOUBLES_HINT[String(on) as 'true' | 'false'];
  });
  toggle(ov, 'face', (v) => saveSetting('diceFace', v as 'top' | 'front'));
  switchRow(ov, 'sound', (on) => sfx.setMuted(!on));
  switchRow(ov, 'fast', (on) => saveSetting('fastBots', on));
}

export async function statsSheet(host: HTMLElement) {
  const s: Stats = await loadStats().catch(() => ({ ...EMPTY_STATS }));
  const rate = s.played ? `${Math.round((100 * s.wins) / s.played)}%` : '–';
  const best = s.best ? ['', '1st', '2nd', '3rd', '4th'][s.best]! : '–';
  const cell = (v: string | number, label: string) => `<div class="st"><b class="disp">${v}</b><small>${label}</small></div>`;
  const empty = !s.played && !s.friends;
  const ov = sheet(
    host,
    'Your stats',
    empty
      ? `<div class="empty"><b class="disp">No games yet</b><p class="sub">Play a game vs Computer and your wins, kills and best place show up here.</p></div>`
      : `<p class="sub">vs Computer, on this device</p>
    <div class="stats">${cell(s.played, 'Games')}${cell(s.wins, 'Wins')}${cell(rate, 'Win rate')}${cell(best, 'Best place')}${cell(s.kills, 'Kills')}${cell(s.pairs, 'Pairs formed')}</div>
    <p class="sub">With friends: ${s.friends} game${s.friends === 1 ? '' : 's'}</p>
    <button class="reset" data-act="reset">Reset stats</button>`,
  );
  const reset = ov.querySelector<HTMLButtonElement>('[data-act=reset]');
  reset?.addEventListener('click', async () => {
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
