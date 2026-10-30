// Vector art shared by all screens. Ported from mockups/index.html.
import { COLORS, SAFE_SQUARES, START, type Color } from '../engine';
import { ARROW, CELL as S, CORNER, HOME_COL, SLOT, TIPS, TRACK, TURNS, centerOf } from './geometry';
import { AVATARS } from './avatars';

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
  play: `<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z" fill="#1ea53a" stroke="#1ea53a" stroke-width="2" stroke-linejoin="round"/></svg>`,
};

/** Gradients and filters referenced by every SVG on the page; mounted once. */
export function globalDefs(): string {
  let g = '';
  for (const c of COLORS) {
    const v = PALETTE[c];
    g += `<linearGradient id="pb-${c}" x1="0" x2="1"><stop offset="0" stop-color="${v.l}"/><stop offset=".42" stop-color="${v.m}"/><stop offset="1" stop-color="${v.d}"/></linearGradient>
    <radialGradient id="ph-${c}" cx=".36" cy=".32" r=".78"><stop offset="0" stop-color="${v.l}"/><stop offset=".45" stop-color="${v.m}"/><stop offset="1" stop-color="${v.d}"/></radialGradient>
    <linearGradient id="base-${c}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${v.l}"/><stop offset=".5" stop-color="${v.m}"/><stop offset="1" stop-color="${v.d}"/></linearGradient>
    <linearGradient id="tile-${c}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${v.l}"/><stop offset="1" stop-color="${v.m}"/></linearGradient>`;
  }
  g += `<linearGradient id="tileW" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eee6d8"/></linearGradient>
  <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#ece3d2"/></linearGradient>
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
  <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.6"/></filter>`;
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${g}</defs></svg>`;
}

// ---------- pawns ----------
/** A pawn drawn around (0, 0): shadow, an invisible tap target and the body. */
export function pawnArt(c: Color): string {
  const v = PALETTE[c];
  return `<ellipse cx="1.5" cy="13.6" rx="13" ry="4.6" fill="#000" opacity=".38" filter="url(#soft)"/>
<circle class="hit" cx="0" cy="-2" r="22" fill="transparent"/>
<g class="pawn-art"><ellipse cx="0" cy="11.2" rx="12.5" ry="4.8" fill="${v.d}"/>
<ellipse cx="0" cy="9.6" rx="12.5" ry="4.8" fill="url(#pb-${c})"/>
<path d="M-9.4,9.6 C-9.4,3 -4.6,0 -3.9,-6 L3.9,-6 C4.6,0 9.4,3 9.4,9.6 Q0,13.2 -9.4,9.6Z" fill="url(#pb-${c})"/>
<ellipse cx="0" cy="-5.6" rx="6.2" ry="2.5" fill="${v.d}"/>
<ellipse cx="0" cy="-6.4" rx="6.2" ry="2.5" fill="${v.m}"/>
<circle cx="0" cy="-13" r="7.6" fill="url(#ph-${c})"/>
<path d="M-6.4,7.5 C-6,3 -3.6,.5 -2.8,-4" stroke="#fff" stroke-opacity=".38" stroke-width="1.6" fill="none" stroke-linecap="round"/>
<ellipse cx="-2.7" cy="-16.2" rx="2.7" ry="1.7" fill="#fff" opacity=".8"/></g>`;
}
export const pawnSVG = (c: Color) => `<svg viewBox="-17 -24 34 42">${pawnArt(c)}</svg>`;
export const twinsSVG = (c: Color) =>
  `<svg viewBox="-24 -26 48 46"><ellipse cx="0" cy="14" rx="20" ry="6.5" fill="#ffd23f" opacity=".5"/><g transform="translate(7 0) scale(.9)">${pawnArt(c)}</g><g transform="translate(-7 4) scale(.9)">${pawnArt(c)}</g></svg>`;

// ---------- board ----------
function tile(x: number, y: number, f: string): string {
  const px = x * S + 1.5, py = y * S + 1.5, w = S - 3;
  const fill = f === 'w' ? 'url(#tileW)' : `url(#tile-${f})`;
  return `<rect x="${px}" y="${py + 1.8}" width="${w}" height="${w}" rx="6" fill="#5a4320" opacity=".2"/><rect x="${px}" y="${py}" width="${w}" height="${w}" rx="6" fill="${fill}"/>`;
}

function base(c: Color): string {
  const [cx, cy] = CORNER[c], bx = cx * S, by = cy * S, v = PALETTE[c];
  let s = `<rect x="${bx + 3}" y="${by + 3}" width="234" height="234" rx="20" fill="url(#base-${c})"/>
  <path d="M${bx + 23},${by + 3} h194 a20,20 0 0 1 20,20 v40 C${bx + 170},${by + 50} ${bx + 70},${by + 40} ${bx + 3},${by + 90} v-67 a20,20 0 0 1 20,-20z" fill="#fff" opacity=".13"/>
  <rect x="${bx + 38}" y="${by + 41}" width="164" height="164" rx="30" fill="#000" opacity=".2"/>
  <rect x="${bx + 38}" y="${by + 36}" width="164" height="164" rx="30" fill="url(#panel)"/>`;
  for (const [sx, sy] of SLOT) {
    s += `<circle cx="${bx + sx}" cy="${by + sy}" r="25" fill="${v.t}"/><circle cx="${bx + sx}" cy="${by + sy}" r="25" fill="url(#slotShade)"/><circle cx="${bx + sx}" cy="${by + sy}" r="25" fill="none" stroke="${v.m}" stroke-opacity=".55" stroke-width="2.5"/>`;
  }
  return s;
}

// Path arrows in a printed-board style: thin ink lines with open arrowheads.
const INK = '#3b2a17';
const head = (x: number, y: number, ang: number, size = 7) =>
  `<path d="M${-size},${-size * 0.75} L0,0 L${-size},${size * 0.75}" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${ang.toFixed(1)})"/>`;
const deg = (dx: number, dy: number) => (Math.atan2(dy, dx) * 180) / Math.PI;
const line = (d: string) => `<path d="${d}" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`;

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
      s += `<path d="M-3.5,-5 L1.5,0 L-3.5,5" fill="none" stroke="${INK}" stroke-opacity=".55" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" transform="translate(${(x + dx).toFixed(1)} ${(y + dy).toFixed(1)}) rotate(${ang})"/>`;
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

/** The static board plus empty layers for the board view to fill. */
export function boardSVG(): string {
  let s = `<svg viewBox="0 0 600 600" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="600" fill="#d6cbb6"/>`;
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
    s += `<path d="${starPath(x * S + 20, y * S + 21, 12, 5.2)}" fill="${st ? '#fff' : '#cbbfa9'}" ${st ? 'fill-opacity=".92"' : ''}/>`;
  }
  s += turnArrows() + tipArrows() + startChevrons();
  for (const c of COLORS) s += homeArrows(c);
  for (const c of COLORS) s += base(c);
  s += `<polygon points="240,240 240,360 300,300" fill="url(#base-green)"/><polygon points="240,240 360,240 300,300" fill="url(#base-red)"/>
  <polygon points="360,240 360,360 300,300" fill="url(#base-yellow)"/><polygon points="240,360 360,360 300,300" fill="url(#base-blue)"/>
  <path d="M240,240 L360,360 M360,240 L240,360" stroke="#fff" stroke-opacity=".55" stroke-width="2"/>
  <circle cx="300" cy="302" r="16" fill="#000" opacity=".2"/><circle cx="300" cy="300" r="16" fill="#fffaf0"/><path d="${starPath(300, 301, 10, 4.5)}" fill="#ffc21a" stroke="#d58a06" stroke-width="1.2"/>`;
  return s + `<g class="deco"></g><g class="fx"></g><g class="pieces"></g><g class="marks"></g><g class="badges"></g></svg>`;
}

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
