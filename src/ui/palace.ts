// The palace cutscene that welcomes a token home (the castle on the board itself is palaceSVG in art.ts).
// Each colour has its own kingdom (setting, characters and particles). All vector art and Web
// Animations, like the rest of the game: no images, no video.
import { FINISHED, type Color } from '../engine';
import { PALETTE, pawnArt } from './art';
import { sfx } from './sfx';

const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Inline style so an SVG element scales and turns around its own box, not the canvas origin. */
const box = (origin = '50% 50%') => `style="transform-box:fill-box;transform-origin:${origin}"`;
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

// ---------- the kingdoms ----------

interface Kingdom {
  name: string;
  /** Sky from top to horizon. */
  sky: [string, string, string];
  wall: string;
  wallD: string;
  roof: string;
  roofD: string;
  /** Lit windows and the light behind the gate. */
  glow: string;
  ground: string;
  road: string;
  /** Colours for the burst when the gate closes. */
  burst: string[];
}

export const KINGDOMS: Record<Color, Kingdom> = {
  red: {
    name: 'The Ember Keep', sky: ['#1c0409', '#6e1020', '#ff7a2a'], wall: '#6a3434', wallD: '#431b1d', roof: '#ee3535', roofD: '#9a1414',
    glow: '#ffb347', ground: '#3a1513', road: '#5b2a20', burst: ['#ffd23f', '#ff8a3d', '#ff3b3b', '#fff3b0'],
  },
  green: {
    name: 'The Emerald Grove', sky: ['#0c3a2c', '#2b8a5a', '#c6f2a8'], wall: '#d3dfb8', wallD: '#93a77e', roof: '#1faf4c', roofD: '#0a6a2a',
    glow: '#fff59a', ground: '#3d9c4c', road: '#c9b37a', burst: ['#8be99c', '#1faf4c', '#fff59a', '#d8f5a0'],
  },
  yellow: {
    name: 'The Sun Citadel', sky: ['#ff8f3a', '#ffc24a', '#fff3c0'], wall: '#f5dca4', wallD: '#c99a52', roof: '#ffbd14', roofD: '#b06f00',
    glow: '#fffbe0', ground: '#efbe63', road: '#f8dc9a', burst: ['#ffd23f', '#ff5d8f', '#4fd1ff', '#7af06a', '#fff'],
  },
  blue: {
    name: 'The Tide Palace', sky: ['#031a36', '#0a4f8f', '#3fb6e8'], wall: '#e8f3ff', wallD: '#9cbbe0', roof: '#1f7bff', roofD: '#0a3c9c',
    glow: '#bff4ff', ground: '#d9c99c', road: '#efe2bb', burst: ['#bff4ff', '#7cc0ff', '#ffffff', '#ffd23f'],
  },
};

/** The castle, front on. Its gate is centred at x 195, standing on the ground at y 430. */
function castle(k: Kingdom, c: Color, glow: string): string {
  const flag = (x: number, y: number, s = 1) =>
    `<g transform="translate(${x} ${y}) scale(${s})"><path d="M0,1 V-34" stroke="#5a3a1a" stroke-width="2.5" stroke-linecap="round"/>
    <path class="cs-flag" d="M0,-34 Q12,-38 25,-31 Q12,-26 0,-21Z" fill="${PALETTE[c].m}" stroke="${PALETTE[c].d}" stroke-width="1.2" ${box('0% 50%')}/></g>`;
  const merlons = (x0: number, x1: number, y: number) => {
    let s = '';
    for (let x = x0; x + 9 <= x1; x += 14) s += `<rect x="${x}" y="${y}" width="9" height="11" rx="1.5"/>`;
    return s;
  };
  const win = (x: number, y: number) => `<path class="cs-win" d="M${x - 5},${y + 9} V${y} a5,5 0 0 1 10,0 V${y + 9}Z" fill="${k.glow}"/>`;
  const tower = (x: number) => `<rect x="${x - 25}" y="262" width="50" height="168" fill="${k.wallD}"/><rect x="${x - 22}" y="262" width="44" height="168" fill="${k.wall}"/>
    <polygon points="${x - 31},268 ${x},196 ${x + 31},268" fill="${k.roof}"/><polygon points="${x},196 ${x + 31},268 ${x},268" fill="${k.roofD}" opacity=".45"/>`;
  return `<g class="cs-castle">${tower(117)}${tower(273)}
    <g fill="${k.wall}">${merlons(137, 256, 294)}</g>
    <rect x="132" y="304" width="126" height="126" fill="${k.wallD}"/><rect x="135" y="304" width="120" height="126" fill="${k.wall}"/>
    <rect x="166" y="226" width="58" height="82" fill="${k.wallD}"/><rect x="169" y="226" width="52" height="82" fill="${k.wall}"/>
    <polygon points="158,232 195,148 232,232" fill="${k.roof}"/><polygon points="195,148 232,232 195,232" fill="${k.roofD}" opacity=".45"/>
    <g stroke="${k.wallD}" stroke-opacity=".45" stroke-width="2" stroke-linecap="round"><path d="M142,322 h18 M228,340 h20 M146,404 h14 M236,398 h12 M100,330 h12 M262,372 h14 M104,402 h10 M280,300 h10"/></g>
    ${win(117, 292)}${win(273, 292)}${win(117, 344)}${win(273, 344)}${win(195, 258)}${win(152, 330)}${win(238, 330)}
    ${flag(117, 197)}${flag(273, 197)}${flag(195, 149, 1.35)}
    <path d="M167,430 V386 a28,28 0 0 1 56,0 V430Z" fill="#160b06"/>
    <path class="cs-inside" d="M167,430 V386 a28,28 0 0 1 56,0 V430Z" fill="url(#${glow})" opacity="0"/>
    <path class="cs-door-l" d="M167,430 V386 A28,28 0 0 1 195,358 V430Z" fill="${k.roofD}" stroke="#2a1408" stroke-width="1.5" ${box('0% 50%')}/>
    <path class="cs-door-r" d="M223,430 V386 A28,28 0 0 0 195,358 V430Z" fill="${k.roofD}" stroke="#2a1408" stroke-width="1.5" ${box('100% 50%')}/>
    <path d="M163,430 V386 a32,32 0 0 1 64,0 V430" fill="none" stroke="${k.wallD}" stroke-width="6"/></g>`;
}

/** The ground in front of the castle and the road the token walks up. */
const ground = (k: Kingdom) =>
  `<rect x="0" y="428" width="390" height="132" fill="${k.ground}"/><path d="M167,430 L223,430 L290,560 L100,560Z" fill="${k.road}"/>
  <path d="M167,430 L223,430 L232,446 L158,446Z" fill="#000" opacity=".12"/>`;

/** Each kingdom's scenery behind and in front of the castle, and its animation. */
interface Scene {
  back: (k: Kingdom) => string;
  front: (k: Kingdom) => string;
  /** Starts the looping life of the scene. */
  live: (root: SVGSVGElement, play: Play) => void;
  /** The characters' cheer as the gate opens. */
  cheer: (root: SVGSVGElement, play: Play) => void;
}
type Play = (el: Element, frames: Keyframe[], ms: number, opts?: KeyframeAnimationOptions) => void;

const all = (root: Element, sel: string) => [...root.querySelectorAll(sel)];

/** Particles that drift up from below and fade: embers, bubbles. */
function risers(cls: string, n: number, shape: (i: number) => string) {
  let s = '';
  for (let i = 0; i < n; i++) s += `<g transform="translate(${rnd(10, 380).toFixed(0)} ${rnd(380, 560).toFixed(0)})"><g class="${cls}">${shape(i)}</g></g>`;
  return s;
}
function rise(root: Element, cls: string, play: Play, dist: number, sway: number, ms: [number, number]) {
  for (const el of all(root, `.${cls}`)) {
    const dx = rnd(-sway, sway);
    play(el, [{ transform: 'translate(0,0)', opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 0.9, offset: 0.7 }, { transform: `translate(${dx}px,${-dist}px)`, opacity: 0 }], rnd(...ms), { iterations: Infinity, delay: -rnd(0, 3000) });
  }
}

// ---------- stick figures ----------
// The kingdoms' people are plain stick figures: a hollow round head, a line body, and arms and legs
// that bend at the joints. Each limb hangs from its joint at the local origin, so a CSS rotate swings
// it about the shoulder or hip.

interface Stick {
  /** What the front hand holds, drawn with the hand at (0, 0). */
  hold?: string;
  /** Headwear, drawn with the head's centre at (0, 0) and the face looking toward +x. */
  hat?: string;
  /** Footwear, drawn at the end of each leg (the foot at 0, 0, the leg pointing up). */
  shoe?: string;
  /** Sitting on a ledge: the hips are at (x, y) and the legs dangle forward. */
  sit?: boolean;
}

/** A stick figure standing with its feet at (x, y) (or sitting with its hips there), facing +x when flip is 1. */
function stick(x: number, y: number, ink: string, flip: 1 | -1, { hold = '', hat = '', shoe = '', sit = false }: Stick = {}): string {
  const line = (d: string, w = 3.2) => `<path d="${d}" stroke="${ink}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
  const hip = sit ? 0 : -24;
  // Each leg hangs from the hip, so it can swing or kick on its own.
  const leg = (d: string, [fx, fy]: [number, number]) => `<g class="cs-leg">${line(d)}<g transform="translate(${fx} ${fy})">${shoe}</g></g>`;
  const legs = sit
    ? `<g class="cs-legs">${leg('M0,0 L13,-1 L15,15', [15, 15])}${leg('M0,0 L11,2 L10,18', [10, 18])}</g>`
    : `<g transform="translate(0 ${hip})">${leg('M0,0 L-9,24', [-9, 24])}${leg('M0,0 L9,24', [9, 24])}</g>`;
  const head = hip - 33;
  return `<g transform="translate(${x} ${y}) scale(${flip} 1)"><g class="cs-stick${sit ? ' sit' : ''}">${legs}${line(`M0,${hip} L0,${hip - 24}`)}
    <circle cx="0" cy="${head}" r="8.5" fill="none" stroke="${ink}" stroke-width="3.2"/>
    <circle cx="-2.4" cy="${head - 1}" r="1.3" fill="${ink}"/><circle cx="3" cy="${head - 1}" r="1.3" fill="${ink}"/>${line(`M-2.6,${head + 3} q3,2.6 6,0`, 1.6)}
    <g transform="translate(0 ${head})">${hat}</g>
    <g transform="translate(0 ${hip - 20})"><g class="cs-arm-b">${line('M0,0 L-10,11 L-13,23')}</g></g>
    <g transform="translate(0 ${hip - 20})"><g class="cs-arm">${line('M0,0 L11,9 L20,4')}<g transform="translate(20 4)">${hold}</g></g></g></g></g>`;
}

// Each kingdom's gear.
/** Red: a knight's helmet with a flame-red plume. */
const HELMET = `<path d="M-10,-1 a10,10 0 0 1 20,0Z" fill="#c9d2e0" stroke="#5a6278" stroke-width="1.4"/><path d="M-10,-1 h20" stroke="#5a6278" stroke-width="2"/>
  <path d="M-1,-10 C-4,-20 5,-25 9,-21 C3,-19 3,-14 -1,-10Z" fill="#ee3535" stroke="#9a1414" stroke-width="1"/>`;
/** Green: a crown of leaves. */
const LEAVES = `<ellipse cx="-6" cy="-8" rx="3" ry="5.5" fill="#3fc35f" transform="rotate(-35 -6 -8)"/><ellipse cx="0" cy="-10.5" rx="3" ry="6" fill="#1faf4c"/>
  <ellipse cx="6" cy="-8" rx="3" ry="5.5" fill="#3fc35f" transform="rotate(35 6 -8)"/>`;
/** Yellow: a marching-band hat with a gold plume. */
const BAND_HAT = `<rect x="-7.5" y="-21" width="15" height="13" rx="2" fill="#1f7bff" stroke="#0a3c9c" stroke-width="1.2"/><rect x="-7.5" y="-12" width="15" height="2.5" fill="#ffd23f"/>
  <rect x="-10" y="-9" width="18" height="3" rx="1.5" fill="#0a3c9c"/><path d="M4,-20 C4,-28 10,-31 13,-27" stroke="#ffd23f" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
/** Blue: a dive mask over the eyes and a snorkel. */
const MASK = `<path d="M-9,-1 C-9,-6 -4,-6 -4,-3" stroke="#ffbd14" stroke-width="1.8" fill="none"/>
  <rect x="-5" y="-5" width="12" height="7" rx="3" fill="#bff4ff" fill-opacity=".55" stroke="#ffbd14" stroke-width="1.8"/>
  <path d="M-8,4 Q-12,4 -12,-2 L-12,-17" stroke="#ff7a2a" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
/** Blue: flippers. */
const FLIPPER = `<path d="M-2.5,-1 L2.5,-1 L7,13 C3,15 -3,15 -7,13Z" fill="#ffbd14" stroke="#b06f00" stroke-width="1.1" stroke-linejoin="round"/>`;

const TORCH = `<path d="M0,0 L4,-22" stroke="#5a3a1a" stroke-width="3.6" stroke-linecap="round"/><g transform="translate(4 -22)"><g class="cs-flame" ${box('50% 100%')}>
  <path d="M0,-18 C7,-8 7,-3 0,1 C-7,-3 -7,-8 0,-18Z" fill="#ff8a3d"/><path d="M0,-11 C4,-5 4,-2 0,1 C-4,-2 -4,-5 0,-11Z" fill="#ffe98f"/></g></g>`;
const TRUMPET = `<path d="M-2,-2 L16,-5 L22,-12 L24,8 L16,2 L-2,2Z" fill="#ffd23f" stroke="#b06f00" stroke-width="1.2" stroke-linejoin="round"/>`;
const TWIG = `<path d="M0,0 L8,-18" stroke="#5a3a1a" stroke-width="2.4" stroke-linecap="round"/><ellipse cx="8" cy="-23" rx="4.5" ry="7" fill="#1faf4c"/>
  <ellipse cx="3" cy="-15" rx="3.5" ry="5.5" fill="#3fc35f" transform="rotate(-35 3 -15)"/><ellipse cx="13" cy="-14" rx="3.5" ry="5.5" fill="#3fc35f" transform="rotate(35 13 -14)"/>`;

/** Arms up and a couple of jumps (sitting figures stay put and just throw their arms up). Ends where it started. */
function hooray(root: Element, play: Play, arm = -80) {
  for (const f of all(root, '.cs-stick:not(.sit)')) play(f, [{ transform: 'translateY(0)' }, { transform: 'translateY(-18px)', offset: 0.25 }, { transform: 'translateY(0)', offset: 0.5 }, { transform: 'translateY(-10px)', offset: 0.72 }, { transform: 'translateY(0)' }], 1000, { fill: 'none' });
  for (const a of all(root, '.cs-arm')) play(a, [{ transform: 'rotate(0deg)' }, { transform: `rotate(${arm}deg)`, offset: 0.2 }, { transform: `rotate(${arm + 10}deg)`, offset: 0.8 }, { transform: 'rotate(0deg)' }], 1300, { fill: 'none' });
  for (const a of all(root, '.cs-arm-b')) play(a, [{ transform: 'rotate(0deg)' }, { transform: 'rotate(85deg)', offset: 0.2 }, { transform: 'rotate(70deg)', offset: 0.5 }, { transform: 'rotate(85deg)', offset: 0.8 }, { transform: 'rotate(0deg)' }], 1300, { fill: 'none' });
}

/** A gentle back-and-forth on every match, each at its own pace. */
function sway(root: Element, sel: string, play: Play, from: string, to: string, ms: [number, number]) {
  for (const el of all(root, sel)) play(el, [{ transform: from }, { transform: to }], rnd(...ms), { iterations: Infinity, direction: 'alternate', easing: 'ease-in-out', delay: -rnd(0, 1000) });
}

const SCENES: Record<Color, Scene> = {
  // Volcanoes, a lava river, and two guards holding torches at the gate.
  red: {
    back: () => `<polygon points="-10,430 70,236 104,246 170,430" fill="#1a0508"/><polygon points="230,430 316,214 350,226 400,330 400,430" fill="#22070b"/>
      <ellipse cx="86" cy="240" rx="22" ry="7" fill="#ff7a2a" filter="url(#soft)"/><ellipse cx="333" cy="219" rx="20" ry="6" fill="#ff7a2a" filter="url(#soft)"/>
      <path d="M86,242 C80,280 94,300 84,340" stroke="#ff6a1a" stroke-width="5" fill="none" stroke-linecap="round" opacity=".85"/>
      <path d="M333,222 C340,262 326,290 338,330" stroke="#ff6a1a" stroke-width="4" fill="none" stroke-linecap="round" opacity=".8"/>`,
    front: () => `<g stroke="#ff7a2a" stroke-width="2" fill="none" opacity=".7" stroke-linecap="round"><path d="M30,470 l20,10 l-6,14 M320,480 l18,-8 l10,16 M60,530 l14,-6 M330,540 l-18,6"/></g>
      <path d="M0,520 C40,510 60,540 100,548 L100,560 L0,560Z M390,512 C350,506 320,536 290,550 L290,560 L390,560Z" fill="#ff6a1a"/>
      <path d="M0,524 C40,514 60,544 100,552 M390,516 C350,510 320,540 290,554" stroke="#ffd23f" stroke-width="2" fill="none" opacity=".7"/>
      ${stick(134, 432, '#ffe9d6', 1, { hold: TORCH, hat: HELMET })}${stick(256, 432, '#ffe9d6', -1, { hold: TORCH, hat: HELMET })}
      ${risers('cs-ember', 26, (i) => `<circle r="${rnd(1.2, 3).toFixed(1)}" fill="${i % 3 ? '#ffb347' : '#ff6a1a'}"/>`)}`,
    live: (root, play) => {
      for (const f of all(root, '.cs-flame')) play(f, [{ transform: 'scale(1,1)' }, { transform: 'scale(.9,1.12)' }, { transform: 'scale(1.05,.94)' }, { transform: 'scale(1,1)' }], rnd(380, 520), { iterations: Infinity });
      sway(root, '.cs-arm-b', play, 'rotate(-6deg)', 'rotate(8deg)', [900, 1300]);
      rise(root, 'cs-ember', play, 300, 40, [2200, 3600]);
    },
    cheer: (root, play) => {
      hooray(root, play, -55);
      for (const f of all(root, '.cs-flame')) play(f, [{ transform: 'scale(1)' }, { transform: 'scale(1.9)', offset: 0.3 }, { transform: 'scale(1)' }], 900, { fill: 'none', composite: 'add' });
      sfx.flare();
    },
  },
  // Rolling hills, round trees, two people on the branches waving twigs, and fireflies.
  green: {
    back: () => {
      let trees = '';
      for (const [x, y, r, col] of [[30, 330, 40, '#1d6b3c'], [80, 310, 34, '#2a8248'], [330, 320, 42, '#1d6b3c'], [370, 300, 30, '#2a8248'], [130, 350, 26, '#3a9a55'], [262, 352, 26, '#3a9a55']] as const) {
        trees += `<rect x="${x - 4}" y="${y}" width="8" height="${430 - y}" fill="#5a3a1a"/><circle cx="${x}" cy="${y}" r="${r}" fill="${col}"/><circle cx="${x - r * 0.35}" cy="${y - r * 0.35}" r="${r * 0.45}" fill="#fff" opacity=".08"/>`;
      }
      return `<path d="M-10,360 C60,300 140,330 200,350 C260,320 330,300 400,350 L400,430 L-10,430Z" fill="#2f7d4a"/>
        <path d="M-10,390 C80,350 160,380 220,392 C300,370 350,360 400,384 L400,430 L-10,430Z" fill="#3f9a55"/>${trees}`;
    },
    front: () => {
      let s = '';
      for (const [x, y] of [[40, 470], [120, 500], [300, 480], [350, 520], [70, 540], [250, 540]] as const) s += `<path d="M${x},${y} l-4,-10 M${x},${y} l0,-13 M${x},${y} l4,-10" stroke="#2a7a3a" stroke-width="2.4" stroke-linecap="round"/>`;
      for (const [x, y] of [[60, 452], [330, 458]] as const) s += `<rect x="${x - 2}" y="${y - 10}" width="4" height="10" fill="#fff3e0"/><path d="M${x - 9},${y - 9} a9,7 0 0 1 18,0Z" fill="#ee3535"/><circle cx="${x - 3}" cy="${y - 13}" r="1.6" fill="#fff"/><circle cx="${x + 3}" cy="${y - 11}" r="1.3" fill="#fff"/>`;
      // A trunk at each side with a branch reaching in, and someone sitting on it.
      s += `<rect x="30" y="250" width="14" height="310" fill="#5a3a1a"/><rect x="346" y="250" width="14" height="310" fill="#5a3a1a"/>
        <path d="M40,356 C60,352 82,353 100,360 M350,356 C330,352 308,353 290,360" stroke="#5a3a1a" stroke-width="7" stroke-linecap="round" fill="none"/>
        ${stick(70, 352, '#1d140a', 1, { sit: true, hold: TWIG, hat: LEAVES })}${stick(320, 352, '#1d140a', -1, { sit: true, hold: TWIG, hat: LEAVES })}`;
      for (let i = 0; i < 20; i++) s += `<g transform="translate(${rnd(10, 380).toFixed(0)} ${rnd(150, 520).toFixed(0)})"><g class="cs-fly"><circle r="3.2" fill="#fff59a" filter="url(#soft)"/><circle r="1.3" fill="#fff"/></g></g>`;
      return s;
    },
    live: (root, play) => {
      for (const f of all(root, '.cs-fly')) {
        const [dx, dy] = [rnd(-30, 30), rnd(-30, 30)];
        play(f, [{ transform: 'translate(0,0)', opacity: 0.2 }, { transform: `translate(${dx}px,${dy}px)`, opacity: 1 }, { transform: `translate(${-dy}px,${dx}px)`, opacity: 0.3 }, { transform: 'translate(0,0)', opacity: 0.2 }], rnd(2400, 4000), { iterations: Infinity, delay: -rnd(0, 3000) });
      }
      // Swinging legs, and the twig waved slowly.
      sway(root, '.cs-legs', play, 'rotate(-14deg)', 'rotate(16deg)', [600, 800]);
      sway(root, '.cs-arm', play, 'rotate(-30deg)', 'rotate(6deg)', [700, 1000]);
    },
    cheer: (root, play) => {
      hooray(root, play, -95);
      sfx.whistle();
    },
  },
  // A blazing sun, dunes, bunting, and two trumpeters at the gate.
  yellow: {
    back: () => {
      let rays = '';
      for (let i = 0; i < 12; i++) rays += `<polygon points="-7,-64 7,-64 0,-120" fill="#fff6c8" opacity=".75" transform="rotate(${i * 30})"/>`;
      return `<g transform="translate(195 140)"><g class="cs-rays" ${box()}>${rays}</g><circle r="56" fill="#fff3b0"/><circle r="46" fill="#ffe27a"/></g>
        <path d="M-10,380 C70,330 150,350 210,380 C270,350 340,330 400,370 L400,430 L-10,430Z" fill="#f2b85a"/>
        <path d="M-10,410 C90,380 170,400 230,412 C300,396 350,392 400,404 L400,430 L-10,430Z" fill="#e9a443"/>
        <path d="M117,250 Q195,290 273,250" stroke="#7a4200" stroke-width="1.5" fill="none"/>
        ${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => { const x = 125 + i * 17.5, y = 250 + Math.sin((i / 8) * Math.PI) * 19; return `<path d="M${x - 6},${y} L${x + 6},${y} L${x},${y + 13}Z" fill="${['#ee3535', '#1f7bff', '#1faf4c'][i % 3]}"/>`; }).join('')}`;
    },
    front: () => {
      let s = `<path d="M20,480 q20,-6 40,0 M300,470 q24,-6 48,0 M90,530 q20,-5 40,0 M260,536 q18,-5 36,0" stroke="#d89a3e" stroke-width="2" fill="none" stroke-linecap="round"/>
        ${stick(134, 432, '#3b2a17', 1, { hold: TRUMPET, hat: BAND_HAT })}${stick(256, 432, '#3b2a17', -1, { hold: TRUMPET, hat: BAND_HAT })}`;
      for (let i = 0; i < 18; i++) s += `<g transform="translate(${rnd(10, 380).toFixed(0)} ${rnd(40, 380).toFixed(0)})"><path class="cs-spark" d="M0,-6 L1.6,-1.6 6,0 1.6,1.6 0,6 -1.6,1.6 -6,0 -1.6,-1.6Z" fill="#fff" ${box()}/></g>`;
      s += [0, 1, 2, 3, 4, 5].map((i) => `<g transform="translate(${i % 2 ? 222 : 150} 380)"><text class="cs-note" font-size="20" fill="#fff" stroke="#b06f00" stroke-width=".8" opacity="0">${i % 3 ? '♪' : '♫'}</text></g>`).join('');
      return s;
    },
    live: (root, play) => {
      play(root.querySelector('.cs-rays')!, [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], 14000, { iterations: Infinity });
      for (const sp of all(root, '.cs-spark')) play(sp, [{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0) rotate(90deg)', opacity: 0 }], rnd(1000, 1800), { iterations: Infinity, delay: -rnd(0, 1800) });
      sway(root, '.cs-arm-b', play, 'rotate(-4deg)', 'rotate(10deg)', [500, 700]);
    },
    cheer: (root, play) => {
      // Trumpets up (the front arm holds the trumpet), and a little bounce.
      for (const a of all(root, '.cs-arm')) play(a, [{ transform: 'rotate(0deg)' }, { transform: 'rotate(-34deg)', offset: 0.15 }, { transform: 'rotate(-30deg)', offset: 0.85 }, { transform: 'rotate(0deg)' }], 1500, { fill: 'none' });
      for (const f of all(root, '.cs-stick')) play(f, [{ transform: 'translateY(0)' }, { transform: 'translateY(-8px)' }, { transform: 'translateY(0)' }], 380, { iterations: 3, fill: 'none' });
      all(root, '.cs-note').forEach((n, i) => play(n, [{ transform: 'translate(0,0)', opacity: 0 }, { opacity: 1, offset: 0.2 }, { transform: `translate(${(i % 2 ? 1 : -1) * rnd(10, 40)}px,-${rnd(90, 150)}px)`, opacity: 0 }], 1300, { delay: 150 + i * 120, fill: 'both' }));
      sfx.trumpets();
    },
  },
  // Under the sea: light rays, seaweed, coral, two divers in masks and flippers treading water, and rising bubbles.
  blue: {
    back: () => `${[40, 140, 250, 330].map((x, i) => `<polygon class="cs-ray" points="${x},0 ${x + 40},0 ${x + 90 - i * 10},430 ${x + 20 - i * 10},430" fill="#fff" opacity=".07"/>`).join('')}
      <path d="M-10,400 C40,370 90,392 130,400 L130,430 L-10,430Z M260,404 C300,380 350,376 400,396 L400,430 L260,430Z" fill="#0b3a66"/>`,
    front: () => {
      const weed = (x: number, h: number, col: string) => `<path class="cs-weed" d="M${x},560 C${x - 14},${560 - h * 0.3} ${x + 14},${560 - h * 0.6} ${x},${560 - h}" stroke="${col}" stroke-width="7" fill="none" stroke-linecap="round" ${box('50% 100%')}/>`;
      return `${weed(18, 160, '#1faf6c')}${weed(36, 120, '#17905a')}${weed(354, 150, '#1faf6c')}${weed(372, 110, '#17905a')}
        <path d="M60,560 C60,520 80,500 90,520 C96,500 110,510 106,560Z M290,560 C292,530 310,514 316,534 C324,516 336,526 330,560Z" fill="#ff7a9a"/>
        <g class="cs-swim">${stick(72, 300, '#f4fbff', 1, { hat: MASK, shoe: FLIPPER })}</g><g class="cs-swim">${stick(318, 326, '#f4fbff', -1, { hat: MASK, shoe: FLIPPER })}</g>
        ${risers('cs-bubble', 24, () => `<circle r="${rnd(2, 6).toFixed(1)}" fill="#bff4ff" fill-opacity=".15" stroke="#fff" stroke-opacity=".75" stroke-width="1.2"/>`)}`;
    },
    live: (root, play) => {
      for (const w of all(root, '.cs-weed')) play(w, [{ transform: 'rotate(-6deg)' }, { transform: 'rotate(6deg)' }], rnd(1300, 1900), { iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });
      sway(root, '.cs-swim', play, 'translateY(0)', 'translateY(-14px)', [1300, 1700]);
      // Treading water: both arms paddle and the flippers kick, one leg against the other.
      all(root, '.cs-swim .cs-leg').forEach((l, i) => play(l, [{ transform: 'rotate(-16deg)' }, { transform: 'rotate(16deg)' }], 420, { iterations: Infinity, direction: 'alternate', easing: 'ease-in-out', delay: i % 2 ? -420 : 0 }));
      sway(root, '.cs-arm', play, 'rotate(-40deg)', 'rotate(10deg)', [450, 600]);
      sway(root, '.cs-arm-b', play, 'rotate(40deg)', 'rotate(-10deg)', [450, 600]);
      for (const r of all(root, '.cs-ray')) play(r, [{ opacity: 0.03 }, { opacity: 0.12 }], rnd(1400, 2200), { iterations: Infinity, direction: 'alternate' });
      rise(root, 'cs-bubble', play, 440, 24, [2600, 4200]);
    },
    cheer: (root, play) => {
      hooray(root, play, -95);
      sfx.bubbles();
    },
  },
};

// ---------- the cutscene ----------

let scenes = 0;

/**
 * Plays the welcome for a token of `c` reaching the palace, on top of `host`. Tap to skip.
 * Resolves when it has gone. `home` is how many of that colour's tokens are now home.
 */
export function playCutscene(host: HTMLElement, c: Color, tokens: number[], speed = 1): Promise<void> {
  const k = KINGDOMS[c], scene = SCENES[c];
  const home = tokens.filter((t) => t === FINISHED).length;
  const quiet = calm();
  // Gradient ids unique to this scene.
  const n = ++scenes;
  const el = document.createElement('div');
  el.className = 'cs';
  el.style.setProperty('--m', PALETTE[c].m);
  el.style.setProperty('--d', PALETTE[c].d);
  el.style.setProperty('--l', PALETTE[c].l);
  el.innerHTML = `<svg viewBox="0 0 390 560" preserveAspectRatio="xMidYMid slice"><defs>
      <linearGradient id="cs-sky${n}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${k.sky[0]}"/><stop offset=".6" stop-color="${k.sky[1]}"/><stop offset="1" stop-color="${k.sky[2]}"/></linearGradient>
      <radialGradient id="cs-glow${n}" cx=".5" cy=".75" r=".7"><stop offset="0" stop-color="#fff"/><stop offset=".4" stop-color="${k.glow}"/><stop offset="1" stop-color="${PALETTE[c].m}"/></radialGradient></defs>
    <g class="cs-cam"><rect width="390" height="560" fill="url(#cs-sky${n})"/>${scene.back(k)}${castle(k, c, `cs-glow${n}`)}${ground(k)}
      <g transform="translate(195 640)"><g class="cs-pawn">${pawnArt(c)}</g></g>${scene.front(k)}<g class="cs-burst"></g></g></svg>
    <div class="cs-top"><small>${k.name}</small></div>
    <div class="cs-title disp">Welcome to<br>the palace!</div>
    <div class="cs-bottom"><span class="cs-count">${home === 4 ? 'All four tokens home!' : `Token ${home} of 4 home`}</span><span class="cs-skip">Tap to skip</span></div>`;
  host.appendChild(el);
  const svg = el.querySelector('svg')!;
  const q = (s: string) => svg.querySelector(s)!;

  const anims: Animation[] = [];
  const timers: number[] = [];
  const play: Play = (target, frames, ms, opts = {}) => {
    const loop = opts.iterations === Infinity;
    // Looping life keeps its pace; the story beats follow the game speed.
    anims.push(target.animate(frames, { fill: 'forwards', easing: 'ease-out', ...opts, duration: loop ? ms : ms / speed, delay: (opts.delay ?? 0) / (loop ? 1 : speed) }));
  };
  const at = (ms: number, f: () => void) => timers.push(window.setTimeout(f, ms / speed));

  return new Promise((done) => {
    let over = false;
    const finish = () => {
      if (over) return;
      over = true;
      timers.forEach(clearTimeout);
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, fill: 'forwards' }).finished.finally(() => {
        anims.forEach((a) => a.cancel());
        el.remove();
        done();
      });
    };
    el.addEventListener('click', finish);
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260 });

    if (quiet) {
      // Reduced motion: the scene and the welcome, still, then gone.
      q('.cs-pawn').setAttribute('transform', 'translate(0 -240) scale(2.2)');
      el.classList.add('show');
      sfx.home();
      at(2200, finish);
      return;
    }

    scene.live(svg, play);
    // The camera settles in.
    play(q('.cs-cam'), [{ transform: 'scale(1.12)' }, { transform: 'scale(1)' }], 1400, { easing: 'cubic-bezier(.2,.8,.2,1)' });

    // The token hops up the road toward the gate, getting smaller as it goes.
    const hops = [[640, 3.4], [560, 3.1], [500, 2.8], [452, 2.5], [404, 2.25]] as const;
    const frames: Keyframe[] = [];
    hops.forEach(([y, s], i) => {
      const o = i / (hops.length - 1);
      if (i > 0) {
        const [py, ps] = hops[i - 1]!;
        frames.push({ transform: `translate(0px,${(py + y) / 2 - 640 - 34}px) scale(${((ps + s) / 2) * 1.02},${((ps + s) / 2) * 0.98})`, offset: o - 0.5 / (hops.length - 1), easing: 'ease-in' });
      }
      frames.push({ transform: `translate(0px,${y - 640}px) scale(${s * 1.06},${s * 0.92})`, offset: o, easing: 'ease-out' });
    });
    play(q('.cs-pawn'), frames, 1600, { easing: 'linear' });
    for (let i = 1; i < hops.length; i++) at(200 + i * 350, () => sfx.hop());

    at(1150, () => scene.cheer(svg, play));
    // The gate swings open and light spills out.
    at(1350, () => {
      play(q('.cs-door-l'), [{ transform: 'scaleX(1)' }, { transform: 'scaleX(.08)' }], 520, { easing: 'cubic-bezier(.3,.7,.3,1)' });
      play(q('.cs-door-r'), [{ transform: 'scaleX(1)' }, { transform: 'scaleX(.08)' }], 520, { easing: 'cubic-bezier(.3,.7,.3,1)' });
      play(q('.cs-inside'), [{ opacity: 0 }, { opacity: 1 }], 500);
      for (const w of all(svg, '.cs-win')) play(w, [{ opacity: 0.6 }, { opacity: 1 }], 300, { iterations: 4, direction: 'alternate' });
      sfx.gate();
    });
    // In it goes, and the camera follows it through the gate.
    at(1800, () => {
      play(q('.cs-pawn'), [{ transform: 'translate(0px,-236px) scale(2.25)', opacity: 1 }, { transform: 'translate(0px,-250px) scale(1.5)', opacity: 1, offset: 0.6 }, { transform: 'translate(0px,-254px) scale(1.2)', opacity: 0 }], 650, { easing: 'ease-in' });
      play(q('.cs-cam'), [{ transform: 'scale(1)' }, { transform: 'scale(1.28)' }], 1500, { easing: 'cubic-bezier(.4,0,.2,1)' });
      el.classList.add('show');
      sfx.fanfare();
    });
    // The gate closes behind it, and the kingdom celebrates.
    at(2500, () => {
      play(q('.cs-door-l'), [{ transform: 'scaleX(.08)' }, { transform: 'scaleX(1)' }], 380, { easing: 'ease-in' });
      play(q('.cs-door-r'), [{ transform: 'scaleX(.08)' }, { transform: 'scaleX(1)' }], 380, { easing: 'ease-in' });
      play(q('.cs-inside'), [{ opacity: 1 }, { opacity: 0 }], 380);
      burst(q('.cs-burst'), k.burst, play);
    });
    at(4300, finish);
  });
}

/** A celebration burst above the gate in the kingdom's colours. */
function burst(g: Element, colors: string[], play: Play) {
  const NS = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < 34; i++) {
    const a = (i / 34) * Math.PI * 2 + rnd(0, 0.3), d = rnd(70, 150);
    const wrap = document.createElementNS(NS, 'g');
    wrap.setAttribute('transform', 'translate(195 330)');
    const p = document.createElementNS(NS, i % 3 ? 'circle' : 'path');
    if (i % 3) p.setAttribute('r', rnd(2.5, 5).toFixed(1));
    else p.setAttribute('d', 'M0,-7 L2,-2 7,0 2,2 0,7 -2,2 -7,0 -2,-2Z');
    p.setAttribute('fill', colors[i % colors.length]!);
    wrap.appendChild(p);
    g.appendChild(wrap);
    play(p, [{ transform: 'translate(0,0) scale(.3)', opacity: 1 }, { transform: `translate(${Math.cos(a) * d}px,${Math.sin(a) * d * 0.8 + 30}px) scale(1) rotate(200deg)`, opacity: 0 }], rnd(900, 1400), { easing: 'cubic-bezier(.16,1,.3,1)' });
  }
}
