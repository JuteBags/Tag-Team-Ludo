// The online mode picker (#204, #210): which game, as tiles a player reads at a glance: a player-facing name
// (Free for all, Duel, Double duel, Teams) and a tiny picture of who sits where, in house colours. For Double
// duel, where a person's two colours sit. Its own piece: it renders, handles its own taps, reports the choice.
import { GAME_MODES, modeSlots, type GameMode, type Pairing } from '../net/protocol';
import type { Color } from '../engine';
import { PALETTE } from './art';
import { sfx } from './sfx';

export interface ModeChoice {
  mode: GameMode;
  pairing: Pairing;
}

/** The modes as players say them (#210). The technical labels (1v1v1v1…) stay in the protocol. */
export const MODE_NAME: Record<GameMode, string> = { ffa: 'Free for all', '1v1': 'Duel', duo: 'Double duel', '2v2': 'Teams' };
/** One short line under the name: who plays (say less: numbers, not sentences). */
export const MODE_LINE: Record<GameMode, string> = { ffa: '4 players', '1v1': '2 players', duo: '2 players, 2 colours', '2v2': '2 v 2' };

/** Where each colour's house is on the board (the game's layout): green top left, red top right, blue bottom left, yellow bottom right. */
const QUAD: Record<Color, [number, number]> = { green: [0, 0], red: [1, 0], blue: [0, 1], yellow: [1, 1] };

/**
 * Who sits where, as a tiny board: the four houses in their corners, coloured when someone plays them (grey when
 * nobody does). A white dot is a person (a ring: that person's second colour, in Double duel); a white line joins
 * colours on the same side (one person's two colours, or partners in Teams).
 */
export function seatPic(mode: GameMode, pairing: Pairing = 'opposite', size = 56): string {
  const slots = modeSlots(mode, pairing);
  const used = new Set(slots.flatMap((s) => s.colors));
  const c = 13; // a quadrant's centre offset in a 52-unit board
  const at = (col: Color) => QUAD[col].map((v) => (v ? 52 - c : c)) as [number, number];
  const quads = (Object.keys(QUAD) as Color[])
    .map((col) => {
      const [qx, qy] = QUAD[col];
      const on = used.has(col);
      return `<rect x="${2 + qx * 25}" y="${2 + qy * 25}" width="23" height="23" rx="5" fill="${on ? PALETTE[col].m : 'rgba(255,255,255,.12)'}"${on ? '' : ' stroke="rgba(255,255,255,.25)" stroke-dasharray="3 3"'}/>`;
    })
    .join('');
  // Same side: one line through its colours (both of a person's colours, or both partners).
  const bySide = new Map<number, Color[]>();
  for (const s of slots) bySide.set(s.side, [...(bySide.get(s.side) ?? []), ...s.colors]);
  const links = [...bySide.values()]
    .filter((cs) => cs.length > 1)
    .map((cs) => {
      const [a, b] = [at(cs[0]!), at(cs[1]!)];
      return `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".9"/>`;
    })
    .join('');
  // A person's first colour is a solid dot; their second colour (Double duel) a hollow ring: one person, two houses.
  const dots = slots
    .flatMap((s) => s.colors.map((col, k) => [at(col), k] as const))
    .map(([[x, y], k]) => (k === 0 ? `<circle cx="${x}" cy="${y}" r="5" fill="#fff" stroke="rgba(0,0,0,.35)" stroke-width="1.5"/>` : `<circle cx="${x}" cy="${y}" r="4.2" fill="${'none'}" stroke="#fff" stroke-width="2.4"/>`))
    .join('');
  return `<svg class="seatpic" viewBox="0 0 54 54" width="${size}" height="${size}" aria-hidden="true">${quads}${links}${dots}</svg>`;
}

const tg = (k: string, items: [string, string][], on: string) => `<div class="tg" data-k="${k}">${items.map(([v, t]) => `<button data-v="${v}"${v === on ? ' class="on"' : ''}>${t}</button>`).join('')}</div>`;

/** The picker's rows (a fragment, to sit among the other options), starting at `choice`; `onChange` on every tap. */
export function modePicker(choice: ModeChoice, onChange: (c: ModeChoice) => void): DocumentFragment {
  const c = { ...choice };
  const t = document.createElement('template');
  const tile = (m: GameMode) =>
    `<button class="mtile" role="radio" data-v="${m}" aria-checked="${m === c.mode}" aria-label="${MODE_NAME[m]}, ${MODE_LINE[m]}">${seatPic(m, m === 'duo' ? c.pairing : 'opposite', 48)}<span class="mtxt"><b class="disp">${MODE_NAME[m]}</b><small>${MODE_LINE[m]}</small></span></button>`;
  t.innerHTML = `<div class="row2 q mpick"><span class="lbl">Game</span><div class="mtiles" role="radiogroup" aria-label="Game" data-k="mode">${GAME_MODES.map(tile).join('')}</div></div>
        <div class="row2 q pairq"${c.mode === 'duo' ? '' : ' hidden'}><span class="lbl">Your two colours</span>${tg('pairing', [['opposite', 'Opposite'], ['adjacent', 'Side by side']], c.pairing)}</div>`;
  const frag = t.content;
  const tiles = frag.querySelector<HTMLElement>('.mtiles')!;
  const pairq = frag.querySelector<HTMLElement>('.pairq')!;
  const redraw = () => {
    tiles.querySelectorAll<HTMLElement>('.mtile').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === c.mode)));
    const duo = tiles.querySelector('.mtile[data-v=duo] .seatpic');
    if (duo) duo.outerHTML = seatPic('duo', c.pairing, 48);
    pairq.hidden = c.mode !== 'duo';
  };
  tiles.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('.mtile');
    if (!b || b.dataset.v === c.mode) return;
    sfx.tick();
    c.mode = b.dataset.v as GameMode;
    redraw();
    onChange({ ...c });
  });
  pairq.querySelector('.tg')!.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button');
    if (!b) return;
    sfx.tick();
    pairq.querySelectorAll('.tg button').forEach((x) => x.classList.toggle('on', x === b));
    c.pairing = b.dataset.v as Pairing;
    redraw();
    onChange({ ...c });
  });
  return frag;
}
