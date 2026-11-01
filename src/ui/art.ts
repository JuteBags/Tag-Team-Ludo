// Vector art shared by all screens. Ported from mockups/index.html.
import { COLORS, SAFE_SQUARES, START, type Color } from '../engine';
import { ARROW, CELL as S, CORNER, HOME_COL, SLOT, TIPS, TRACK, TURNS, centerOf } from './geometry';
import { AVATARS } from './avatars';
import { equipped } from './skins';

export const PALETTE: Record<Color, { l: string; m: string; d: string; t: string }> = {
  blue: { l: '#7cc0ff', m: '#1f7bff', d: '#0a3c9c', t: '#dcecff' },
  green: { l: '#8be99c', m: '#1faf4c', d: '#0a6a2a', t: '#dcf6e2' },
  red: { l: '#ff9a90', m: '#ee3535', d: '#9a1414', t: '#ffe2df' },
  yellow: { l: '#ffe58a', m: '#ffbd14', d: '#b06f00', t: '#fff3cf' },
};
export const cssVars = (c: Color) => `--l:${PALETTE[c].l};--m:${PALETTE[c].m};--d:${PALETTE[c].d}`;

export const PROFILES: Record<Color, { name: string }> = {
  blue: { name: 'You' },
  green: { name: 'Aarav' },
  red: { name: 'Meera' },
  yellow: { name: 'Kabir' },
};

export function starPath(cx: number, cy: number, R: number, r: number): string {
  let d = '';
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 ? r : R;
    d += (k ? 'L' : 'M') + (cx + rr * Math.cos(a)).toFixed(2) + ',' + (cy + rr * Math.sin(a)).toFixed(2);
  }
  return d + 'Z';
}

export const icons = {
  menu: `<svg viewBox="0 0 24 24"><path d="M5 7h14M5 12h14M5 17h14" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>`,
  back: `<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  lock: `<svg viewBox="0 0 24 24"><path d="M7.5 10.5V8a4.5 4.5 0 0 1 9 0v2.5" stroke="#fff" stroke-width="2.6" fill="none"/><rect x="5" y="10" width="14" height="10.5" rx="3" fill="#fff"/><circle cx="12" cy="15" r="1.8" fill="#334"/></svg>`,
  globe: `<svg viewBox="0 0 64 64"><circle cx="32" cy="34" r="26" fill="#0b4fa8"/><circle cx="32" cy="32" r="26" fill="url(#gGlobe)"/><g fill="none" stroke="#fff" stroke-opacity=".8" stroke-width="2.5"><ellipse cx="32" cy="32" rx="11" ry="26"/><path d="M6 32h52M10 19h44M10 45h44"/></g><ellipse cx="21" cy="17" rx="9" ry="4.5" fill="#fff" opacity=".4" transform="rotate(-32 21 17)"/></svg>`,
  friends: `<svg viewBox="0 0 64 64"><circle cx="44" cy="22" r="9" fill="#f0b6ff"/><path d="M30 56c1-12 7-19 14-19s14 7 15 19z" fill="#f0b6ff"/><circle cx="24" cy="21" r="11" fill="#fff"/><path d="M4 56c0-13 9-21 20-21s20 8 20 21z" fill="#fff"/></svg>`,
  robot: `<svg viewBox="0 0 48 48"><path d="M24 4v6" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="24" cy="4.5" r="3.2" fill="#ffd23f"/><rect x="8" y="10" width="32" height="26" rx="9" fill="#fff"/><rect x="12" y="15" width="24" height="14" rx="6" fill="#0f2f78"/><circle cx="19" cy="22" r="3.2" fill="#5ff2ff"/><circle cx="29" cy="22" r="3.2" fill="#5ff2ff"/><rect x="4" y="18" width="4" height="10" rx="2" fill="#fff"/><rect x="40" y="18" width="4" height="10" rx="2" fill="#fff"/><rect x="15" y="38" width="18" height="6" rx="3" fill="#fff" opacity=".85"/></svg>`,
  gear: `<svg viewBox="0 0 24 24"><path d="M12 2.5l1.6 2.3 2.8-.5.6 2.8 2.5 1.3-1.1 2.6 1.1 2.6-2.5 1.3-.6 2.8-2.8-.5L12 21.5l-1.6-2.3-2.8.5-.6-2.8-2.5-1.3 1.1-2.6-1.1-2.6 2.5-1.3.6-2.8 2.8.5z" fill="#fff"/><circle cx="12" cy="12" r="3.6" fill="#2459d6"/></svg>`,
  stats: `<svg viewBox="0 0 24 24"><rect x="4" y="12" width="4" height="8" rx="1.2" fill="#fff"/><rect x="10" y="7" width="4" height="13" rx="1.2" fill="#ffd23f"/><rect x="16" y="3.5" width="4" height="16.5" rx="1.2" fill="#fff"/></svg>`,
  share: `<svg viewBox="0 0 24 24"><circle cx="18" cy="5.5" r="3" fill="#fff"/><circle cx="6" cy="12" r="3" fill="#fff"/><circle cx="18" cy="18.5" r="3" fill="#fff"/><path d="M8.6 10.6l6.8-3.6M8.6 13.4l6.8 3.6" stroke="#fff" stroke-width="2.2"/></svg>`,
  play: `<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z" fill="#1ea53a" stroke="#1ea53a" stroke-width="2" stroke-linejoin="round"/></svg>`,
};

/** Gradients and filters referenced by every SVG on the page; mounted once. */
export function globalDefs(): string {
  let g = '';
  for (const c of COLORS) {
    const v = PALETTE[c];
    g += `<radialGradient id="pb-${c}" cx=".3" cy=".25" r="1"><stop offset="0" stop-color="${v.l}"/><stop offset=".42" stop-color="${v.m}"/><stop offset=".82" stop-color="${v.d}"/><stop offset="1" stop-color="${v.d}"/></radialGradient>
    <radialGradient id="ph-${c}" cx=".36" cy=".32" r=".78"><stop offset="0" stop-color="${v.l}"/><stop offset=".45" stop-color="${v.m}"/><stop offset="1" stop-color="${v.d}"/></radialGradient>
    <linearGradient id="base-${c}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${v.l}"/><stop offset=".5" stop-color="${v.m}"/><stop offset="1" stop-color="${v.d}"/></linearGradient>
    <linearGradient id="tile-${c}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${v.l}"/><stop offset="1" stop-color="${v.m}"/></linearGradient>`;
  }
  // Light from the top left: a bright top-left edge, a darker bottom-right one.
  g += `<linearGradient id="bevel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".22" stop-color="#fff" stop-opacity=".08"/><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".2"/></linearGradient>
  <linearGradient id="sunk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".38"/><stop offset=".2" stop-color="#000" stop-opacity="0"/><stop offset=".85" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".35"/></linearGradient>
  <radialGradient id="boneG" cx=".35" cy=".28" r=".9"><stop offset="0" stop-color="#fffaf0"/><stop offset=".55" stop-color="#efe5cc"/><stop offset="1" stop-color="#c9b98f"/></radialGradient>
  <radialGradient id="mglow"><stop offset="0" stop-color="#fff7c2" stop-opacity=".95"/><stop offset=".55" stop-color="#ffd23f" stop-opacity=".55"/><stop offset="1" stop-color="#ffd23f" stop-opacity="0"/></radialGradient>
  <radialGradient id="pao"><stop offset="0" stop-color="#000" stop-opacity=".5"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
  <linearGradient id="tileW" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--b-tile1)"/><stop offset="1" style="stop-color:var(--b-tile2)"/></linearGradient>
  <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--b-panel1)"/><stop offset="1" style="stop-color:var(--b-panel2)"/></linearGradient>
  <radialGradient id="slotShade" cx=".5" cy=".42" r=".6"><stop offset=".5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".22"/></radialGradient>
  <radialGradient id="gCoin" cx=".38" cy=".32" r=".75"><stop offset="0" stop-color="#fff5b8"/><stop offset=".5" stop-color="#ffd23f"/><stop offset="1" stop-color="#f09a0a"/></radialGradient>
  <radialGradient id="gGlobe" cx=".38" cy=".32" r=".8"><stop offset="0" stop-color="#a8ecff"/><stop offset=".5" stop-color="#2bb0ff"/><stop offset="1" stop-color="#0a5fc4"/></radialGradient>
  <linearGradient id="gCup" x1="0" x2="1"><stop offset="0" stop-color="#c27a06"/><stop offset=".22" stop-color="#ffe98f"/><stop offset=".45" stop-color="#ffcf3a"/><stop offset=".8" stop-color="#e99a0c"/><stop offset="1" stop-color="#b56a00"/></linearGradient>
  <linearGradient id="gCupD" x1="0" x2="1"><stop offset="0" stop-color="#8a4a00"/><stop offset=".35" stop-color="#d48a10"/><stop offset="1" stop-color="#7a3d00"/></linearGradient>
  <linearGradient id="gRib" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff6f9a"/><stop offset="1" stop-color="#d21f57"/></linearGradient>
  <linearGradient id="gLeaf" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe98f"/><stop offset="1" stop-color="#d88a08"/></linearGradient>
  <linearGradient id="gSilver" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#9aa8bd"/></linearGradient>
  <linearGradient id="gBronze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd0a0"/><stop offset="1" stop-color="#b85f22"/></linearGradient>
  <linearGradient id="gPlain" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fb4ff"/><stop offset="1" stop-color="#3a5fb0"/></linearGradient>
  <radialGradient id="pshadow"><stop offset="0" stop-color="#000" stop-opacity=".55"/><stop offset=".6" stop-color="#000" stop-opacity=".28"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>`;
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${g}</defs></svg>`;
}

// ---------- colour-blind symbols ----------
/** A shape of radius about r around (0, 0): circle for green, triangle for red, square for yellow, diamond for blue. */
export function symbolPath(c: Color, r: number): string {
  const f = (n: number) => n.toFixed(2);
  if (c === 'green') return `M${f(-r)},0 a${f(r)},${f(r)} 0 1 0 ${f(2 * r)},0 a${f(r)},${f(r)} 0 1 0 ${f(-2 * r)},0Z`;
  if (c === 'red') return `M0,${f(-r * 1.1)} L${f(r)},${f(r * 0.75)} L${f(-r)},${f(r * 0.75)}Z`;
  if (c === 'yellow') return `M${f(-r * 0.85)},${f(-r * 0.85)} h${f(r * 1.7)} v${f(r * 1.7)} h${f(-r * 1.7)}Z`;
  return `M0,${f(-r * 1.15)} L${f(r * 1.05)},0 L0,${f(r * 1.15)} L${f(-r * 1.05)},0Z`;
}

// ---------- pawns ----------
// The pawn's silhouette: a wide base, a bell body, a collar and a round head. Shared by the outline
// and the fill so the two always line up.
const PAWN_BASE = (cy: number) => `<ellipse cx="0" cy="${cy}" rx="11.5" ry="4"/>`;
const PAWN_BODY = '<path d="M-8.6,8.6 C-8.6,2.4 -4.4,-.4 -3.6,-3.6 L3.6,-3.6 C4.4,-.4 8.6,2.4 8.6,8.6 Q0,11.8 -8.6,8.6Z"/>';
const PAWN_HEAD = '<circle cx="0" cy="-8.4" r="6.4"/>';

/**
 * A pawn centred on (0, 0): its body runs from y -14.8 to 14.4, so it sits in the middle of whatever
 * it stands on and fits inside a 40-unit square up to scale 1.3. Shadow, an invisible tap target,
 * a white halo and a dark outline so it reads on any tile (its own colour too), then the glossy body.
 */
/** A pawn skin: its silhouette (for the halo, outline and the board's hit area) and its painted art. */
interface PawnSkin {
  sil: string;
  art: (c: Color) => string;
  /** Where the colour-blind symbol sits, on the skin's body. */
  sym: [number, number];
}

const BASE_ART = (c: Color) => {
  const v = PALETTE[c];
  return `<g fill="${v.d}">${PAWN_BASE(11.4)}<rect x="-11.5" y="8.2" width="23" height="3.2"/></g>
<g fill="url(#pb-${c})">${PAWN_BASE(8.2)}</g>
<path d="M-11.5,8.2 A11.5,4 0 0 0 11.5,8.2" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.1"/>`;
};

const PAWN_SKINS: Record<string, PawnSkin> = {
  // The glossy original.
  classic: {
    sil: `${PAWN_BASE(10.4)}${PAWN_BODY}${PAWN_HEAD}`,
    sym: [0, 3.6],
    art: (c) => {
      const v = PALETTE[c];
      return `${BASE_ART(c)}
<g fill="url(#pb-${c})">${PAWN_BODY}</g>
<path d="M3.6,-3.4 C4.6,-.2 8.6,2.6 8.6,8.6 Q6.6,9.6 4.2,10 C5.4,5 3.4,1 2.2,-3.4Z" fill="${v.d}" opacity=".45"/>
<path d="M-7.6,8.4 Q0,11 7.6,8.4" fill="none" stroke="${v.l}" stroke-opacity=".7" stroke-width="1.1" stroke-linecap="round"/>
<ellipse cx="0" cy="-3.4" rx="5.8" ry="2.2" fill="${v.d}"/>
<ellipse cx="0" cy="-4.1" rx="5.8" ry="2.2" fill="${v.m}"/>
<g fill="url(#ph-${c})">${PAWN_HEAD}</g>
<path d="M3.2,-13.6 A6.4,6.4 0 0 1 4.6,-3.9" fill="none" stroke="${v.l}" stroke-opacity=".55" stroke-width="1.1" stroke-linecap="round"/>
<path d="M-5.6,7 C-5.4,3.2 -3.4,1 -2.6,-1.8" stroke="#fff" stroke-opacity=".7" stroke-width="2.2" fill="none" stroke-linecap="round"/>
<ellipse cx="-2.3" cy="-10.8" rx="3.2" ry="2" fill="#fff" opacity=".6"/>
<circle cx="-3" cy="-11.5" r="1.15" fill="#fff"/>`;
    },
  },
  // Halloween: a real skull (a big round cranium narrowing to a small jaw) on a base in the player's
  // colour; the eyes glow in that colour.
  skull: {
    sil: `${PAWN_BASE(10.4)}<path d="M-8.6,-3 C-10.4,-9.4 -6.8,-16 0,-16 C6.8,-16 10.4,-9.4 8.6,-3 C8.2,.2 6.8,1.6 5.2,2.4 L4.8,7.4 Q0,9.6 -4.8,7.4 L-5.2,2.4 C-6.8,1.6 -8.2,.2 -8.6,-3Z"/>`,
    sym: [0, -10.2],
    art: (c) => {
      const v = PALETTE[c];
      return `${BASE_ART(c)}
<path d="M-8.6,-3 C-10.4,-9.4 -6.8,-16 0,-16 C6.8,-16 10.4,-9.4 8.6,-3 C8.2,.2 6.8,1.6 5.2,2.4 L4.8,7.4 Q0,9.6 -4.8,7.4 L-5.2,2.4 C-6.8,1.6 -8.2,.2 -8.6,-3Z" fill="url(#boneG)"/>
<path d="M5.2,2.4 L4.8,7.4 Q0,9.6 -4.8,7.4 L-5.2,2.4 C-2,3.4 2,3.4 5.2,2.4Z" fill="#d9ccab"/>
<path d="M8.6,-3 C8.2,.2 6.8,1.6 5.2,2.4 C6.4,-1 7.4,-6 6,-11 C8.8,-9 9.8,-6 8.6,-3Z" fill="#b8a780" opacity=".55"/>
<path d="M-7.2,-6.6 C-7,-9 -4.6,-10 -1.4,-8.8 C-.4,-7.6 -.6,-4.6 -2.2,-3.2 C-4,-2.2 -6.6,-3 -7.2,-6.6Z" fill="#1a120c"/>
<path d="M7.2,-6.6 C7,-9 4.6,-10 1.4,-8.8 C.4,-7.6 .6,-4.6 2.2,-3.2 C4,-2.2 6.6,-3 7.2,-6.6Z" fill="#1a120c"/>
<circle cx="-3.9" cy="-5.8" r="1.4" fill="${v.l}"/><circle cx="3.9" cy="-5.8" r="1.4" fill="${v.l}"/>
<circle cx="-4.3" cy="-6.2" r=".5" fill="#fff"/><circle cx="3.5" cy="-6.2" r=".5" fill="#fff"/>
<path d="M0,-2.2 L-1.4,.6 Q0,1.2 1.4,.6Z" fill="#1a120c"/>
<path d="M-4,3.6 Q0,4.8 4,3.6 L3.8,6.6 Q0,7.8 -3.8,6.6Z" fill="#f4ecd8"/>
<path d="M-2.6,3.9 v3.2 M-.9,4.1 v3.4 M.9,4.1 v3.4 M2.6,3.9 v3.2 M-3.8,5.3 Q0,6.3 3.8,5.3" stroke="#5a4a32" stroke-width=".6" fill="none"/>
<path d="M2.6,-15.4 L3.4,-12.6 L2.2,-11" stroke="#9a8a68" stroke-width=".6" fill="none"/>
<ellipse cx="-3.6" cy="-12.6" rx="3" ry="1.6" fill="#fff" opacity=".85" transform="rotate(-18 -3.6 -12.6)"/>`;
    },
  },
  // One scoop in the player's colour on a waffle cone, standing in a little holder.
  cone: {
    sil: `${PAWN_BASE(10.4)}<path d="M-7.2,-2 L7.2,-2 L0,10Z"/><circle cx="0" cy="-7.4" r="7.6"/>`,
    sym: [0, -7.4],
    art: (c) => {
      const v = PALETTE[c];
      return `${BASE_ART(c)}
<path d="M-7.2,-2 L7.2,-2 L0,10Z" fill="#d79a4e"/>
<path d="M-5.2,-2 L1.6,8 M-1.6,-2 L3.6,5.2 M2,-2 L5.4,2.4 M5.2,-2 L-1.6,8 M1.6,-2 L-3.6,5.2 M-2,-2 L-5.4,2.4" stroke="#a96a26" stroke-width=".8"/>
<path d="M3.6,-2 L0,10 L7.2,-2Z" fill="#8a5a22" opacity=".35"/>
<circle cx="0" cy="-7.4" r="7.6" fill="url(#ph-${c})"/>
<path d="M-7.4,-5.6 Q-6.6,-1 -5.2,-3.8 Q-4,-.4 -2.6,-3.6 Q-1.2,0 .4,-3.4 Q2,-.6 3.4,-3.6 Q5,-.8 6,-4 Q7.2,-2.2 7.4,-5.6Z" fill="${v.m}"/>
<rect x="-3.6" y="-11" width="2" height=".8" rx=".4" fill="#fff" transform="rotate(30 -2.6 -10.6)"/><rect x="1.6" y="-9" width="2" height=".8" rx=".4" fill="#ffe14d" transform="rotate(-40 2.6 -8.6)"/><rect x="-1" y="-6.4" width="2" height=".8" rx=".4" fill="#7af06a" transform="rotate(70 0 -6)"/>
<circle cx="0" cy="-15.2" r="2.1" fill="#e8102c"/><circle cx="-.6" cy="-15.8" r=".6" fill="#fff"/>
<ellipse cx="-3" cy="-10.6" rx="2.4" ry="1.4" fill="#fff" opacity=".55"/>`;
    },
  },
  // A boxy robot: a body in the player's colour, a steel head with a glowing visor and an antenna.
  robot: {
    sil: `${PAWN_BASE(10.4)}<rect x="-7.4" y="-3.4" width="14.8" height="12.4" rx="3"/><rect x="-6.4" y="-14.4" width="12.8" height="10" rx="3"/><circle cx="0" cy="-17.2" r="1.8"/>`,
    sym: [0, 3],
    art: (c) => {
      const v = PALETTE[c];
      return `${BASE_ART(c)}
<rect x="-7.4" y="-3.4" width="14.8" height="12.4" rx="3" fill="url(#pb-${c})"/>
<rect x="2.6" y="-3.4" width="4.8" height="12.4" rx="2" fill="${v.d}" opacity=".4"/>
<rect x="-3" y="-5" width="6" height="2" fill="#9aa6b8"/>
<rect x="-6.4" y="-14.4" width="12.8" height="10" rx="3" fill="#cfd8e6"/>
<rect x="1.6" y="-14.4" width="4.8" height="10" rx="2" fill="#8d99ad" opacity=".7"/>
<rect x="-4.8" y="-11.6" width="9.6" height="4" rx="2" fill="#16203a"/>
<rect x="-3.6" y="-10.6" width="2.6" height="2" rx="1" fill="${v.l}"/><rect x="1" y="-10.6" width="2.6" height="2" rx="1" fill="${v.l}"/>
<path d="M0,-14.4 V-16" stroke="#8d99ad" stroke-width="1.2"/><circle cx="0" cy="-17.2" r="1.8" fill="${v.m}"/>
<rect x="-5.4" y="-13.8" width="5" height="1.4" rx=".7" fill="#fff" opacity=".8"/>`;
    },
  },
  // A chess knight in the player's colour.
  knight: {
    sil: `${PAWN_BASE(10.4)}<path d="M-7.8,9 L-6.8,1 C-8.4,-5 -6.6,-11.6 -.6,-15.4 C2.6,-16.6 4.6,-15.4 5.8,-13.2 L9,-8.4 C10,-6.4 8.4,-5 6.4,-6 L3.2,-5.6 C5.2,-1.6 7.6,3 7.8,9Z"/>`,
    sym: [-0.6, 3.6],
    art: (c) => {
      const v = PALETTE[c];
      return `${BASE_ART(c)}
<path d="M-7.8,9 L-6.8,1 C-8.4,-5 -6.6,-11.6 -.6,-15.4 C2.6,-16.6 4.6,-15.4 5.8,-13.2 L9,-8.4 C10,-6.4 8.4,-5 6.4,-6 L3.2,-5.6 C5.2,-1.6 7.6,3 7.8,9Z" fill="url(#pb-${c})"/>
<path d="M3.2,-5.6 C5.2,-1.6 7.6,3 7.8,9 L4,9 C4,4 2.4,0 .8,-4.4Z" fill="${v.d}" opacity=".45"/>
<path d="M-.6,-15.4 C-4.4,-12.6 -6.2,-8 -5.6,-3.4 C-6.6,1 -6.6,5 -6.4,8.6" fill="none" stroke="${v.d}" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="1.6 1.4"/>
<circle cx="3.4" cy="-10.6" r="1.2" fill="#14203a"/><circle cx="3.1" cy="-10.9" r=".4" fill="#fff"/>
<path d="M-3.4,-12.6 C-2,-14 0,-14.8 1.6,-14.6" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="1.6" stroke-linecap="round"/>`;
    },
  },
};

/**
 * A pawn centred on (0, 0), in the pawn skin in use (skins.ts): it sits in the middle of whatever it
 * stands on and fits inside a 40-unit square up to scale 1.3. Shadow, an invisible tap target, a glow
 * and white halo for your own pawns, the replay's ring for the pawn that just moved, a dark outline so it
 * reads on any tile, then the skin's art.
 */
export function pawnArt(c: Color, skin: string = equipped('pawn').id): string {
  const v = PALETTE[c];
  const k = PAWN_SKINS[skin] ?? PAWN_SKINS.classic!;
  const outline = (color: string, w: number) => `<g fill="${color}" stroke="${color}" stroke-width="${w}" stroke-linejoin="round">${k.sil}</g>`;
  // The shadow is a gradient, not a blur filter: filters are redrawn on every frame of every hop.
  return `<ellipse cx="4.5" cy="14.6" rx="15" ry="5" fill="url(#pshadow)"/>
<circle class="hit" cx="0" cy="0" r="20" fill="transparent"/>
<ellipse class="mineglow" cx="0" cy="11" rx="18" ry="7" fill="url(#mglow)"/>
<ellipse class="movedring" cx="0" cy="11" rx="17" ry="6.5" fill="none" stroke="#ffd65a" stroke-width="2.6"/>
<g class="pawn-art"><g class="halo">${outline('#fff', 5.2)}</g>${outline(v.d, 2.6)}
<ellipse cx="1" cy="12.6" rx="12" ry="3.4" fill="#000" opacity=".45"/>
${k.art(c)}
<path class="sym" d="${symbolPath(c, 5.4)}" transform="translate(${k.sym[0]} ${k.sym[1]})" fill="#fff" stroke="${v.d}" stroke-width="1.4" stroke-linejoin="round"/></g>`;
}
export const pawnSVG = (c: Color, skin?: string) => `<svg viewBox="-15 -17 30 34">${pawnArt(c, skin)}</svg>`;
export const twinsSVG = (c: Color) =>
  `<svg viewBox="-22 -19 44 38"><ellipse cx="0" cy="13" rx="19" ry="5.5" fill="#ffd23f" opacity=".5"/><g transform="translate(7 -1) scale(.9)">${pawnArt(c)}</g><g transform="translate(-7 3) scale(.9)">${pawnArt(c)}</g></svg>`;

// ---------- board ----------
function tile(x: number, y: number, f: string): string {
  const px = x * S + 1.5, py = y * S + 1.5, w = S - 3;
  const fill = f === 'w' ? 'url(#tileW)' : `url(#tile-${f})`;
  const side = f === 'w' ? 'fill:var(--b-side)' : `fill:${PALETTE[f as Color].d}`;
  const h = w - 6.5;
  // Classes let a board theme restyle the parts (the Tron board draws them as lines of light).
  return `<rect class="tsh" x="${px + 2.5}" y="${py + 4}" width="${w}" height="${w}" rx="6" style="fill:var(--b-shade)" opacity=".35"/><rect class="tsd" x="${px}" y="${py + 6.5}" width="${w}" height="${h}" rx="6" style="${side}"/><rect class="tf t-${f}" x="${px}" y="${py}" width="${w}" height="${h}" rx="6" fill="${fill}"/><rect class="tbv" x="${px}" y="${py}" width="${w}" height="${h}" rx="6" fill="url(#bevel)"/><path class="thl" d="M${px + 6},${py + 1} h${w - 12}" stroke="#fff" stroke-opacity=".8" stroke-width="1.4" stroke-linecap="round"/>`;
}

function base(c: Color): string {
  const [cx, cy] = CORNER[c], bx = cx * S, by = cy * S, v = PALETTE[c];
  let s = `<g class="base b-${c}"><rect class="bsh" x="${bx + 8}" y="${by + 12}" width="232" height="228" rx="20" fill="#000" opacity=".35"/>
  <rect class="bsd" x="${bx + 3}" y="${by + 17}" width="234" height="220" rx="20" fill="${v.d}"/>
  <rect class="bt" x="${bx + 3}" y="${by + 3}" width="234" height="220" rx="20" fill="url(#base-${c})"/>
  <rect class="bbv" x="${bx + 3}" y="${by + 3}" width="234" height="220" rx="20" fill="url(#bevel)" opacity=".8"/>
  <path class="bgl" d="M${bx + 23},${by + 3} h194 a20,20 0 0 1 20,20 v40 C${bx + 170},${by + 50} ${bx + 70},${by + 40} ${bx + 3},${by + 90} v-67 a20,20 0 0 1 20,-20z" fill="#fff" opacity=".13"/>
  <rect class="bpr" x="${bx + 34}" y="${by + 26}" width="172" height="172" rx="33" fill="${v.d}" opacity=".7"/>
  <rect class="bp" x="${bx + 38}" y="${by + 30}" width="164" height="164" rx="30" fill="url(#panel)"/>
  <rect class="bsk" x="${bx + 38}" y="${by + 30}" width="164" height="164" rx="30" fill="url(#sunk)"/>
  <path class="sym" d="${symbolPath(c, 12)}" transform="translate(${bx + 120} ${by + 118})" fill="${v.m}" opacity=".7"/>`;
  for (const [sx, sy] of SLOT) {
    s += `<circle class="bsl" cx="${bx + sx}" cy="${by + sy}" r="25" fill="${v.t}"/><circle class="bss" cx="${bx + sx}" cy="${by + sy}" r="25" fill="url(#slotShade)"/><circle class="bsr" cx="${bx + sx}" cy="${by + sy}" r="25" fill="none" stroke="${v.m}" stroke-opacity=".55" stroke-width="2.5"/>`;
  }
  return s + '</g>';
}

// Path arrows in a printed-board style: thin ink lines with open arrowheads.
/** Arrow ink, from the theme. */
const INK = 'var(--b-ink)';
const head = (x: number, y: number, ang: number, size = 7) =>
  `<path d="M${-size},${-size * 0.75} L0,0 L${-size},${size * 0.75}" fill="none" style="stroke:${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${ang.toFixed(1)})"/>`;
const deg = (dx: number, dy: number) => (Math.atan2(dy, dx) * 180) / Math.PI;
const line = (d: string) => `<path d="${d}" fill="none" style="stroke:${INK}" stroke-width="3" stroke-linecap="round"/>`;

/** A short diagonal arrow across each inner corner, where the track jumps into the next arm. */
function turnArrows(): string {
  let s = '';
  for (const { from, to } of TURNS) {
    const [ax, ay] = centerOf(from), [bx, by] = centerOf(to);
    const [sx, sy] = [ax + (bx - ax) * 0.2, ay + (by - ay) * 0.2], [ex, ey] = [ax + (bx - ax) * 0.8, ay + (by - ay) * 0.8];
    s += `<g class="turn" opacity=".8">${line(`M${sx},${sy} L${ex},${ey}`)}${head(ex, ey, deg(bx - ax, by - ay))}</g>`;
  }
  return s;
}

/** A curved U-turn arrow over the outer tip of each arm, bowed toward the board edge. */
function tipArrows(): string {
  let s = '';
  for (const { from, mid, to } of TIPS) {
    const [mx, my] = centerOf(mid);
    const n = [Math.sign(mx - 300), Math.sign(my - 300)] as const; // outward
    const [ax, ay] = centerOf(from), [bx, by] = centerOf(to);
    const p0 = [ax + n[0] * 3, ay + n[1] * 3], p2 = [bx + n[0] * 3, by + n[1] * 3], c = [mx + n[0] * 27, my + n[1] * 27];
    s += `<g class="tip" opacity=".8">${line(`M${p0[0]},${p0[1]} Q${c[0]},${c[1]} ${p2[0]},${p2[1]}`)}${head(p2[0]!, p2[1]!, deg(p2[0]! - c[0]!, p2[1]! - c[1]!))}</g>`;
  }
  return s;
}

/** ">>>" on the square after each start, pointing the way round. */
function startChevrons(): string {
  let s = '';
  for (const c of COLORS) {
    const a = TRACK[START[c] + 1]!, b = TRACK[START[c] + 2]!;
    const [x, y] = centerOf(a);
    const ang = deg(b[0] - a[0], b[1] - a[1]);
    for (const k of [-8, 0, 8]) {
      const dx = Math.cos((ang * Math.PI) / 180) * k, dy = Math.sin((ang * Math.PI) / 180) * k;
      s += `<path d="M-3.5,-5 L1.5,0 L-3.5,5" fill="none" style="stroke:${INK}" stroke-opacity=".55" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" transform="translate(${(x + dx).toFixed(1)} ${(y + dy).toFixed(1)}) rotate(${ang})"/>`;
    }
  }
  return s;
}

/** A bold arrow on each colour's entry square pointing into its home lane, plus chevrons up the lane. */
function homeArrows(c: Color): string {
  const [x, y, rot] = ARROW[c];
  const at = (px: number, py: number, inward = 0) => {
    const r = (rot * Math.PI) / 180;
    return `translate(${(px * S + 20 + Math.cos(r) * inward).toFixed(1)} ${(py * S + 20 + Math.sin(r) * inward).toFixed(1)}) rotate(${rot})`;
  };
  // Nudged inward so the U-turn arrow over the arm tip has room.
  let s = `<path d="M-9,-10 L11,0 L-9,10 L-4,0Z" fill="${PALETTE[c].m}" stroke="#fff" stroke-width="2.5" stroke-linejoin="round" transform="${at(x, y, 6)}"/>`;
  for (const [hx, hy] of HOME_COL[c].slice(0, 4)) {
    s += `<path d="M-4,-6 L3,0 L-4,6" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" transform="${at(hx, hy)}"/>`;
  }
  return s;
}

// ---------- the palace (board centre) ----------

const STONE = 'var(--b-stone)';
const STONE_D = 'var(--b-stone-d)';
/** Which way each colour's gate faces, as a rotation of the top gate around the board centre. */
const GATE_TURN: Record<Color, number> = { red: 0, yellow: 90, blue: 180, green: 270 };

/** The centre of the board (240..360): four colour courts inside a walled castle with a round keep. */
export function palaceSVG(): string {
  let s = `<polygon points="240,240 240,360 300,300" fill="url(#base-green)"/><polygon points="240,240 360,240 300,300" fill="url(#base-red)"/>
  <polygon points="360,240 360,360 300,300" fill="url(#base-yellow)"/><polygon points="240,360 360,360 300,300" fill="url(#base-blue)"/>
  <path d="M252,252 L348,348 M348,252 L252,348" stroke="#fff" stroke-opacity=".45" stroke-width="2"/>
  <rect x="244" y="245.5" width="112" height="112" rx="5" fill="none" style="stroke:${STONE_D}" stroke-width="5"/>
  <rect x="244" y="244" width="112" height="112" rx="5" fill="none" style="stroke:${STONE}" stroke-width="5"/>`;
  // Battlements on each wall, leaving the middle for the gatehouse.
  for (const turn of [0, 90, 180, 270]) {
    let m = '';
    for (const x of [259, 271, 329, 341]) m += `<rect x="${x - 3}" y="239.5" width="6" height="6" rx="1" style="fill:${STONE};stroke:${STONE_D}" stroke-width=".8"/>`;
    s += `<g transform="rotate(${turn} 300 300)">${m}</g>`;
  }
  // A gatehouse facing each colour's home lane, with a door in that colour.
  for (const [c, turn] of Object.entries(GATE_TURN) as [Color, number][]) {
    s += `<g transform="rotate(${turn} 300 300)"><rect x="288" y="237" width="24" height="14" rx="3" style="fill:${STONE_D}" transform="translate(0 1.2)"/>
    <rect x="288" y="237" width="24" height="14" rx="3" style="fill:${STONE}"/>
    <path d="M294.5,251 V245 a5.5,5.5 0 0 1 11,0 V251Z" fill="${PALETTE[c].d}"/><path d="M300,240 V251" stroke="${PALETTE[c].m}" stroke-width="1.2"/></g>`;
  }
  // Corner towers seen from above: stone ring, crenels, a gold roof.
  // Set in from the corners, clear of the arrows where the track turns.
  for (const [x, y] of [[252, 252], [348, 252], [348, 348], [252, 348]] as const) {
    s += `<circle cx="${x}" cy="${y + 1.5}" r="9" style="fill:${STONE_D}"/><circle cx="${x}" cy="${y}" r="9" style="fill:${STONE}"/>
    <circle cx="${x}" cy="${y}" r="7.8" fill="none" style="stroke:${STONE_D}" stroke-width="2.4" stroke-dasharray="2.4 2.2"/>
    <circle cx="${x}" cy="${y}" r="5.2" fill="url(#gCoin)" stroke="#d58a06" stroke-width=".8"/><circle cx="${x - 1.6}" cy="${y - 1.8}" r="1.5" fill="#fff" opacity=".7"/>`;
  }
  // The keep: the home star sits on its golden roof.
  s += `<circle cx="300" cy="302.5" r="23" fill="#000" opacity=".18"/><circle cx="300" cy="300" r="23" style="fill:${STONE}"/>
  <circle cx="300" cy="300" r="21" fill="none" style="stroke:${STONE_D}" stroke-width="3.4" stroke-dasharray="3.4 2.6"/>
  <circle cx="300" cy="300" r="15.5" fill="url(#gCoin)" stroke="#d58a06" stroke-width="1"/>
  <path d="${starPath(300, 301, 9.5, 4.2)}" fill="#fff6c8" stroke="#d58a06" stroke-width="1.1"/>
  <circle cx="294.5" cy="294" r="2.4" fill="#fff" opacity=".6"/>`;
  return s;
}

/** The static board plus empty layers for the board view to fill. */
export function boardSVG(): string {
  let s = `<svg viewBox="0 0 600 600" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="600" style="fill:var(--b-bg)"/>`;
  const fill = new Map<string, string>();
  TRACK.forEach(([x, y]) => fill.set(`${x},${y}`, 'w'));
  for (const c of COLORS) {
    HOME_COL[c].forEach(([x, y]) => fill.set(`${x},${y}`, c));
    const [x, y] = TRACK[START[c]]!;
    fill.set(`${x},${y}`, c);
  }
  for (const [k, f] of fill) {
    const [x, y] = k.split(',').map(Number) as [number, number];
    s += tile(x, y, f);
  }
  const starts = new Set(Object.values(START));
  for (const i of SAFE_SQUARES) {
    const [x, y] = TRACK[i]!;
    const st = starts.has(i);
    s += `<path d="${starPath(x * S + 20, y * S + 21, 12, 5.2)}" ${st ? 'fill="#fff" fill-opacity=".92"' : 'style="fill:var(--b-star)"'}/>`;
  }
  s += tipArrows() + startChevrons();
  for (const c of COLORS) s += homeArrows(c);
  for (const c of COLORS) s += base(c);
  // The turn arrows go over the palace walls, so they always show.
  s += palaceSVG() + turnArrows();
  return s + `<g class="deco"></g><g class="fx"></g><g class="pieces"></g><g class="marks"></g><g class="badges"></g></svg>`;
}

/** The board in a given theme, drawn small (Settings and Store thumbnails). */
export const miniBoard = (theme: string) => `<span class="mini-board" data-theme="${theme}">${boardSVG()}</span>`;

// ---------- avatars ----------
/** The avatar for a colour: a Fun Emoji face (src/ui/avatars.ts, generated by tools/make-avatars.mjs). */
export function avatarSVG(c: Color): string {
  return AVATARS[c];
}

// ---------- result screen ----------
export function trophySVG(): string {
  let leaves = '';
  for (let k = 0; k < 7; k++) {
    const deg = 118 + k * 17, a = (deg * Math.PI) / 180;
    const x = 100 + 78 * Math.cos(a), y = 96 + 78 * Math.sin(a) * 0.95, rot = deg + 65;
    for (const [px, r] of [[x, rot], [200 - x, -rot]] as const) {
      leaves += `<ellipse cx="${px.toFixed(1)}" cy="${y.toFixed(1)}" rx="6" ry="13" fill="url(#gLeaf)" stroke="#a35a00" stroke-width="1" transform="rotate(${r} ${px.toFixed(1)} ${y.toFixed(1)})"/>`;
    }
  }
  const spark = (x: number, y: number, s: number) =>
    `<path d="M${x},${y - s} Q${x},${y} ${x + s},${y} Q${x},${y} ${x},${y + s} Q${x},${y} ${x - s},${y} Q${x},${y} ${x},${y - s}Z" fill="#fff"/>`;
  return `<svg viewBox="0 0 200 190">${leaves}
  <path d="M58,52 C26,50 26,98 66,104" stroke="url(#gCupD)" stroke-width="10" fill="none" stroke-linecap="round"/>
  <path d="M142,52 C174,50 174,98 134,104" stroke="url(#gCupD)" stroke-width="10" fill="none" stroke-linecap="round"/>
  <path d="M56,34 H144 C144,96 124,122 100,126 C76,122 56,96 56,34Z" fill="url(#gCup)"/>
  <path d="M66,40 C66,84 78,106 92,116 C80,104 74,80 74,40Z" fill="#fff" opacity=".35"/>
  <ellipse cx="100" cy="34" rx="44" ry="8.5" fill="#ffe98f" stroke="#c47a00" stroke-width="2"/>
  <ellipse cx="100" cy="35" rx="36" ry="5" fill="#b56a00" opacity=".55"/>
  <path d="${starPath(100, 72, 18, 8)}" fill="#fff6c8" stroke="#d58a06" stroke-width="2"/>
  <rect x="91" y="124" width="18" height="18" fill="url(#gCupD)"/>
  <path d="M70,142 H130 L138,164 H62Z" fill="url(#gCup)"/>
  <rect x="56" y="164" width="88" height="14" rx="5" fill="url(#gCupD)"/>
  <rect x="80" y="148" width="40" height="11" rx="3" fill="#7a3d00" opacity=".55"/>
  ${spark(40, 28, 9)}${spark(166, 40, 7)}${spark(150, 8, 5)}${spark(30, 86, 5)}</svg>`;
}

/** Big medal with the finishing place, for anything but first. */
export function medalSVG(place: number): string {
  const fill = place === 2 ? 'url(#gSilver)' : place === 3 ? 'url(#gBronze)' : 'url(#gPlain)';
  return `<svg viewBox="0 0 200 190"><path d="M70,8 L100,70 L130,8Z" fill="#d21f57"/><path d="M70,8 L86,8 L106,60 L100,70Z" fill="#a8164a"/>
  <circle cx="100" cy="112" r="62" fill="#000" opacity=".25"/><circle cx="100" cy="106" r="62" fill="${fill}" stroke="#fff" stroke-width="5"/>
  <circle cx="100" cy="106" r="48" fill="none" stroke="#000" stroke-opacity=".12" stroke-width="3"/>
  <text x="100" y="128" text-anchor="middle" font-family="Lilita One, sans-serif" font-size="64" fill="#fff" stroke="#00000033" stroke-width="2">${place}</text></svg>`;
}

export const starBadge = (cls: string) =>
  `<svg class="${cls}" viewBox="0 0 40 40"><path d="${starPath(20, 22, 18, 8.4)}" fill="#a35a00"/><path d="${starPath(20, 20, 18, 8.4)}" fill="url(#gCoin)" stroke="#fff6c2" stroke-width="1.2"/></svg>`;

export const ribbonSVG = () => `<svg viewBox="0 0 330 72"><path d="M4,26 H60 V66 H4 L18,46Z" fill="#a8164a"/><path d="M326,26 H270 V66 H326 L312,46Z" fill="#a8164a"/>
  <path d="M44,58 L60,66 V58Z" fill="#5e0a28"/><path d="M286,58 L270,66 V58Z" fill="#5e0a28"/>
  <rect x="40" y="8" width="250" height="50" rx="10" fill="url(#gRib)"/><rect x="48" y="12" width="234" height="8" rx="4" fill="#fff" opacity=".25"/></svg>`;

export function confettiHTML(seed = 11): string {
  let a = seed;
  const rnd = () => ((a = (a * 16807) % 2147483647) / 2147483647);
  const cols = ['#ffd23f', '#ff5d8f', '#4fd1ff', '#7af06a', '#b07cff', '#ff8a3d'];
  let h = '';
  for (let k = 0; k < 80; k++) {
    const x = rnd() * 390, y = rnd() * 560 - 30, w = 4 + rnd() * 5, hh = 8 + rnd() * 8, rot = rnd() * 360, round = rnd() < 0.3;
    const delay = (rnd() * 0.6).toFixed(2);
    h += `<i style="left:${x.toFixed(0)}px;top:${y.toFixed(0)}px;width:${(round ? w + 2 : w).toFixed(1)}px;height:${(round ? w + 2 : hh).toFixed(1)}px;background:${cols[k % 6]};--r:${rot.toFixed(0)}deg;border-radius:${round ? '50%' : '2px'};animation-delay:${delay}s"></i>`;
  }
  return `<div class="confetti">${h}</div>`;
}
