// CSS 3D die with rounded corners. The cube is rebuilt with the rolled value on the face that counts
// (top or front, a player setting), then thrown and tumbled into a resting pose that shows that face
// largest, with a gold rim on it so there is never a doubt which face is the roll.
import { settings, type DiceFace, type ThrowStyle } from './settings';
import { sfx } from './sfx';
import { equipped } from './skins';

const PIPS: Record<number, number[]> = { 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
/** Resting tilt for each counting face: the counting face is the big one you see. */
const REST: Record<DiceFace, [number, number]> = { top: [-56, -24], front: [-16, -22] };

const face = (v: number, cls: string, tf: string, win: boolean) =>
  `<div class="f ${cls}${win ? ' win' : ''}" style="transform:${tf}">${Array.from({ length: 9 }, (_, k) => (PIPS[v]!.includes(k) ? `<i class="p${v === 1 || v === 6 ? ' r' : ''}"></i>` : '<i></i>')).join('')}</div>`;

export function dieMarkup(v: number, size: number, rx?: number, ry?: number, mode: DiceFace = settings.diceFace, skin: string = equipped('dice').id): string {
  const h = size / 2;
  const [restX, restY] = REST[mode];
  // Two faces that are neither v nor its opposite, and not opposite each other.
  const others = [1, 2, 3, 4, 5, 6].filter((n) => n !== v && n !== 7 - v);
  const a = others[0]!;
  const b = others.find((n) => n !== a && n !== 7 - a)!;
  // The counted value goes on the counting face; the rest keep opposite faces adding up to 7.
  const [fr, tp, rt] = mode === 'top' ? [a, v, b] : [v, a, b];
  const tf = { fr: `translateZ(${h}px)`, bk: `rotateY(180deg) translateZ(${h}px)`, rt: `rotateY(90deg) translateZ(${h}px)`, lf: `rotateY(-90deg) translateZ(${h}px)`, tp: `rotateX(90deg) translateZ(${h}px)`, bt: `rotateX(-90deg) translateZ(${h}px)` };
  // An inner core fills the gaps the rounded corners leave at the cube's edges.
  const core = (['fr', 'bk', 'rt', 'lf', 'tp', 'bt'] as const).map((k) => `<div class="c" style="transform:${tf[k].replace(`${h}px`, `${h * 0.86}px`)}"></div>`).join('');
  // The dice skin in use (skins.ts) is a class: its look lives in styles.css (.dk-bone, .dk-tron, ...).
  return `<div class="diew dk-${skin}" style="width:${size}px;height:${size}px;perspective:${size * 7}px"><div class="dsh"></div><div class="die3" style="width:${size}px;height:${size}px;transform:rotateX(${rx ?? restX}deg) rotateY(${ry ?? restY}deg)">${core}
  ${face(7 - fr, 'bk', tf.bk, false)}${face(7 - rt, 'lf', tf.lf, false)}${face(7 - tp, 'bt', tf.bt, false)}
  ${face(tp, 'tp', tf.tp, mode === 'top')}${face(rt, 'rt', tf.rt, false)}${face(fr, 'fr', tf.fr, mode === 'front')}</div></div>`;
}

/** A tiny dice cup, upright: open at the top, gold rim. */
const CUP = `<svg viewBox="0 0 40 46"><defs><linearGradient id="cupG" x1="0" x2="1"><stop offset="0" stop-color="#4a2208"/><stop offset=".42" stop-color="#a65d22"/><stop offset="1" stop-color="#3f1c06"/></linearGradient></defs>
  <path d="M3,8 h34 l-5,33 a3,3 0 0 1 -3,2.6 h-18 a3,3 0 0 1 -3,-2.6z" fill="url(#cupG)"/>
  <ellipse cx="20" cy="8" rx="17.5" ry="5" fill="#ffd23f" stroke="#a35a00" stroke-width="1.2"/><ellipse cx="20" cy="8" rx="14" ry="3.2" fill="#2a1204"/>
  <path d="M10,13 l3,24" stroke="#fff" stroke-opacity=".22" stroke-width="3" stroke-linecap="round"/></svg>`;

/** An ice-cream cone with a scoop: the die drops out when it tips over. */
const CONE = `<svg viewBox="0 0 40 46"><path d="M8,14 h24 l-12,30z" fill="#d79a4e"/>
  <path d="M11,14 l11,22 M16,14 l9,16 M21,14 l7,10 M29,14 l-11,22 M24,14 l-9,16 M19,14 l-7,10" stroke="#a96a26" stroke-width="1.3"/>
  <path d="M5,14 Q4,3 20,2 Q36,3 35,14 Q31,18 28,14 Q25,19 21,14 Q17,19 13,14 Q9,18 5,14z" fill="#ff8fb8"/>
  <circle cx="20" cy="1.8" r="3" fill="#e8102c"/><rect x="12" y="7" width="3.5" height="1.3" rx=".6" fill="#fff" transform="rotate(25 13.7 7.6)"/><rect x="24" y="5" width="3.5" height="1.3" rx=".6" fill="#7af06a" transform="rotate(-30 25.7 5.6)"/></svg>`;

/** A small upturned cup for the three-cups trick. */
const MINI_CUP = `<svg viewBox="0 0 30 30"><path d="M5,28 h20 l-3,-22 a3,3 0 0 0 -3,-2.6 h-8 a3,3 0 0 0 -3,2.6z" fill="#b8312f"/><ellipse cx="15" cy="28" rx="10.5" ry="2.4" fill="#ffd23f"/><path d="M10,8 l-1.6,16" stroke="#fff" stroke-opacity=".35" stroke-width="2.4" stroke-linecap="round"/></svg>`;

/** A skull facing you, its jaw a separate piece so it can open: the die is spat out of its mouth. */
const SKULL_HEAD = `<svg viewBox="0 0 60 60"><defs><radialGradient id="skB" cx=".35" cy=".28" r=".9"><stop offset="0" stop-color="#fffaf0"/><stop offset=".55" stop-color="#efe5cc"/><stop offset="1" stop-color="#c9b98f"/></radialGradient></defs>
  <path d="M10,30 C6,12 18,2 30,2 C42,2 54,12 50,30 C49,36 45,39 42,40 L18,40 C15,39 11,36 10,30Z" fill="url(#skB)" stroke="#8a7a58" stroke-width="1"/>
  <path d="M15,22 C15,16 21,14 26,17 C28,20 27,26 24,28 C20,30 15,28 15,22Z" fill="#1a120c"/><path d="M45,22 C45,16 39,14 34,17 C32,20 33,26 36,28 C40,30 45,28 45,22Z" fill="#1a120c"/>
  <circle class="eye" cx="21" cy="22" r="2.6" fill="#ff7a1a"/><circle class="eye" cx="39" cy="22" r="2.6" fill="#ff7a1a"/>
  <path d="M30,28 L27,34 Q30,35.5 33,34Z" fill="#1a120c"/><path d="M19,38 h22 v3 h-22z" fill="#2a1e14"/>
  <path d="M21,36 v4 M25,36 v4.5 M29,36 v4.5 M33,36 v4.5 M37,36 v4.5" stroke="#7a6a50" stroke-width="1.1"/>
  <path d="M38,5 L40,12 L37,16" stroke="#9a8a68" stroke-width="1" fill="none"/></svg>`;
const SKULL_JAW = `<svg viewBox="0 0 60 24"><path d="M17,0 H43 C44,8 40,16 30,17 C20,16 16,8 17,0Z" fill="#e8dcbe" stroke="#8a7a58" stroke-width="1"/>
  <path d="M21,0 v4 M25,0 v4.5 M29,0 v4.5 M33,0 v4.5 M37,0 v4.5 M19,4 Q30,7 41,4" stroke="#7a6a50" stroke-width="1.1" fill="none"/></svg>`;

/**
 * The skull cup: a skull rattles in, its eyes flare, the jaw drops open and it spits the die out, which
 * rolls to a stop; the skull snaps shut and sinks away.
 */
function skullRoll(box: HTMLElement, v: number, size: number, ms: number): Promise<void> {
  const w = size * 1.5;
  box.innerHTML = `<div class="scene">${dieMarkup(v, size)}<div class="skull" style="width:${w}px;height:${w * 1.4}px;margin:${-w * 0.95}px 0 0 ${-w / 2}px"><div class="sk-head">${SKULL_HEAD}</div><div class="sk-jaw">${SKULL_JAW}</div></div></div>`;
  const q = (c: string) => box.querySelector<HTMLElement>(c)!;
  const wrap = q('.diew'), cube = q('.die3'), shadow = q('.dsh'), skull = q('.skull'), jaw = q('.sk-jaw');
  const [restX, restY] = REST[settings.diceFace];
  const SPIT = 0.46;
  sfx.shake(ms * 0.4);
  // Rattles: quick shakes side to side, then leans forward to spit, then sinks away.
  const rattle: Keyframe[] = [{ transform: 'translateY(30px) scale(.6)', opacity: 0 }, { transform: 'translateY(0) scale(1)', opacity: 1, offset: 0.1 }];
  for (let i = 0; i < 6; i++) rattle.push({ transform: `rotate(${i % 2 ? 9 : -9}deg) translateY(${i % 2 ? -3 : 0}px)`, offset: 0.12 + i * 0.045 });
  rattle.push(
    { transform: 'rotate(0) translateY(-6px) scale(1.05)', offset: SPIT - 0.04 },
    { transform: 'rotate(0) translateY(4px) scale(1.1,.95)', offset: SPIT + 0.02 },
    { transform: 'rotate(0) translateY(0) scale(1)', opacity: 1, offset: 0.7 },
    { transform: 'translateY(26px) scale(.7)', opacity: 0 },
  );
  skull.animate(rattle, { duration: ms }).finished.finally(() => skull.remove());
  // The jaw chatters while it rattles, then drops wide open to spit, then snaps shut.
  const chatter: Keyframe[] = [{ transform: 'translateY(0)' }];
  for (let i = 0; i < 6; i++) chatter.push({ transform: `translateY(${i % 2 ? 0 : 3}px)`, offset: 0.12 + i * 0.045 });
  chatter.push({ transform: 'translateY(0)', offset: SPIT - 0.05 }, { transform: 'translateY(11px) rotate(4deg)', offset: SPIT }, { transform: 'translateY(11px) rotate(4deg)', offset: SPIT + 0.1 }, { transform: 'translateY(0)', offset: SPIT + 0.16 }, { transform: 'translateY(0)' });
  jaw.animate(chatter, { duration: ms });
  box.querySelectorAll<HTMLElement>('.skull .eye').forEach((e) => e.animate([{ fill: '#ff7a1a' }, { fill: '#ff7a1a', offset: SPIT - 0.06 }, { fill: '#fff3a0', offset: SPIT }, { fill: '#ff7a1a' }], { duration: ms }));
  // The die: hidden in the mouth, spat out toward you, then rolls and bounces to a stop.
  const mouth = `translate(0px,${-size * 0.32}px) scale(.3)`;
  wrap.animate(
    [
      { transform: mouth, opacity: 0 },
      { transform: mouth, opacity: 0, offset: SPIT },
      { transform: `translate(0px,${-size * 0.1}px) scale(.8)`, opacity: 1, offset: SPIT + 0.05 },
      { transform: 'translate(6px,6px) scale(1.12,.86)', offset: 0.64 },
      { transform: 'translate(3px,-8px) scale(.98,1.03)', offset: 0.72 },
      { transform: 'translate(1px,2px) scale(1.05,.94)', offset: 0.82 },
      { transform: 'translate(0,0) scale(1)' },
    ],
    { duration: ms },
  );
  shadow.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], { duration: ms });
  const anim = cube.animate(spins(restX, restY), { duration: ms * (1 - SPIT), delay: ms * SPIT, fill: 'backwards' });
  setTimeout(() => sfx.bust(), ms * SPIT);
  setTimeout(() => sfx.land(v), ms * 0.64);
  return anim.finished.then(() => undefined);
}

/** The dice gun: a big blaster, barrel to the right, muzzle at (96, 22) of its 100 x 60 box. */
const GUN = `<svg viewBox="0 0 100 60"><defs><linearGradient id="gunM" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9aa6c0"/><stop offset=".45" stop-color="#4a5470"/><stop offset="1" stop-color="#1e2436"/></linearGradient></defs>
  <path d="M24,30 h16 l-6,26 a3,3 0 0 1 -3,2 h-12 a2,2 0 0 1 -2,-2.6z" fill="#2a3044"/><path d="M27,34 l-4,18" stroke="#495270" stroke-width="2"/>
  <path d="M34,30 q10,0 10,10 h-4 q0,-6 -6,-6z" fill="#1e2436"/>
  <rect x="10" y="12" width="76" height="19" rx="4" fill="url(#gunM)"/>
  <rect x="80" y="16" width="16" height="12" rx="2" fill="#2a3044"/><rect x="93" y="15" width="5" height="14" rx="1.5" fill="#ffc21a"/>
  <rect x="14" y="8" width="44" height="5" rx="2" fill="#2a3044"/><rect x="60" y="15" width="18" height="3" rx="1.5" fill="#ffc21a" opacity=".85"/>
  <path d="M14,15 h64" stroke="#fff" stroke-opacity=".45" stroke-width="2" stroke-linecap="round"/><circle cx="20" cy="22" r="3" fill="#ffc21a"/></svg>`;

/** Each thrower's art, for the Store (toss has none: it's just the die). */
export const THROWER_ART: Record<string, string> = { cup: CUP, skullcup: SKULL_HEAD, cone: CONE, cups3: MINI_CUP, gun: GUN };

/** Tumble keyframes that end in the resting pose. */
function spins(restX: number, restY: number): Keyframe[] {
  const spinX = 720 + 90 * Math.floor(Math.random() * 3);
  const spinY = 540 + 90 * Math.floor(Math.random() * 3);
  return [
    { transform: `rotateX(${restX + spinX}deg) rotateY(${restY + spinY}deg) rotateZ(200deg)` },
    { transform: `rotateX(${restX + 200}deg) rotateY(${restY + 150}deg) rotateZ(60deg)`, offset: 0.55, easing: 'cubic-bezier(.3,.6,.4,1)' },
    { transform: `rotateX(${restX + 18}deg) rotateY(${restY + 12}deg)`, offset: 0.8 },
    { transform: `rotateX(${restX}deg) rotateY(${restY}deg)` },
  ];
}

/** Shows `v` in `box`: shaken in a cup and thrown (or tossed), then rolling to rest. Resolves when it has landed. */
export function rollDie(box: HTMLElement, v: number, size: number, ms: number, style: ThrowStyle = equipped('thrower').id as ThrowStyle): Promise<void> {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    box.innerHTML = dieMarkup(v, size);
    sfx.land(v);
    return Promise.resolve();
  }
  const done =
    style === 'toss' ? tossRoll(box, v, size, ms)
    : style === 'cups3' ? cupsRoll(box, v, size, ms)
    : style === 'gun' ? gunRoll(box, v, size, ms)
    : style === 'skullcup' ? skullRoll(box, v, size, ms)
    : cupRoll(box, v, size, ms, style === 'cone' ? CONE : CUP);
  return Promise.race([done, new Promise<void>((r) => setTimeout(r, ms + 80))]);
}

/**
 * The cup throw. The camera starts pulled back inside the dice box; the cup is shaken up and down,
 * tipped toward the mat to throw the die out, the die rolls and bounces to a stop, and the camera
 * pushes in to the usual close view.
 */
function cupRoll(box: HTMLElement, v: number, size: number, ms: number, art = CUP): Promise<void> {
  box.innerHTML = `<div class="scene">${dieMarkup(v, size)}<div class="cup">${art}</div></div>`;
  const q = (c: string) => box.querySelector<HTMLElement>(c)!;
  const scene = q('.scene'), wrap = q('.diew'), cube = q('.die3'), shadow = q('.dsh'), cup = q('.cup');
  const [restX, restY] = REST[settings.diceFace];
  const THROW = 0.46;
  sfx.shake(ms * 0.4);
  // Camera: pulled back while shaking and rolling, then a push-in as the die settles.
  scene.animate(
    [
      { transform: 'scale(.6)' },
      { transform: 'scale(.6)', offset: 0.72 },
      { transform: 'scale(1.06)', offset: 0.92, easing: 'cubic-bezier(.16,1,.3,1)' },
      { transform: 'scale(1)' },
    ],
    { duration: ms, easing: 'ease-in-out' },
  );
  // Cup: shaken up and down four times, a wind-up, then tipped toward the mat and pulled away.
  const shake: Keyframe[] = [];
  for (let i = 0; i < 4; i++) {
    shake.push({ transform: `translate(-14px,-34px) rotate(${i % 2 ? 4 : -4}deg)`, offset: i * 0.1 + 0.05 });
    shake.push({ transform: 'translate(-14px,-10px) rotate(0deg)', offset: i * 0.1 + 0.1 });
  }
  cup
    .animate(
      [
        { transform: 'translate(-14px,-14px) rotate(0deg)', opacity: 1 },
        ...shake,
        { transform: 'translate(-18px,-30px) rotate(-14deg)', offset: 0.42 },
        // Fully visible until the throw, then it fades while being pulled away.
        { transform: 'translate(-4px,-14px) rotate(78deg)', opacity: 1, offset: THROW + 0.03, easing: 'cubic-bezier(.5,0,.2,1)' },
        { transform: 'translate(-30px,-46px) rotate(40deg)', opacity: 0, offset: 0.66 },
        { transform: 'translate(-30px,-46px) rotate(40deg)', opacity: 0 },
      ],
      { duration: ms },
    )
    .finished.finally(() => cup.remove());
  // Die: hidden in the cup, flung out of its mouth onto the mat, then rolling and bouncing to the centre.
  wrap.animate(
    [
      { transform: 'translate(-8px,-26px) scale(.6)', opacity: 0 },
      { transform: 'translate(-8px,-26px) scale(.6)', opacity: 0, offset: THROW },
      { transform: 'translate(4px,-30px) scale(.85)', opacity: 1, offset: THROW + 0.05 },
      { transform: 'translate(14px,4px) scale(1.1,.88)', offset: 0.6, easing: 'cubic-bezier(.5,0,.8,.6)' },
      { transform: 'translate(9px,-12px) scale(.98,1.03)', offset: 0.68 },
      { transform: 'translate(4px,2px) scale(1.05,.94)', offset: 0.76 },
      { transform: 'translate(2px,-3px)', offset: 0.83 },
      { transform: 'translate(0,0) scale(1)' },
    ],
    { duration: ms, easing: 'linear' },
  );
  shadow.animate([{ opacity: 0 }, { opacity: 0, offset: 0.58 }, { opacity: 1, offset: 0.62 }, { opacity: 1 }], { duration: ms });
  const anim = cube.animate(spins(restX, restY), { duration: ms * (1 - THROW), delay: ms * THROW, fill: 'backwards' });
  setTimeout(() => sfx.land(v), ms * 0.6);
  return anim.finished.then(() => undefined);
}

/**
 * Three cups: shuffled like the street trick (two swaps), then the middle one lifts and the die
 * rolls out from under it.
 */
function cupsRoll(box: HTMLElement, v: number, size: number, ms: number): Promise<void> {
  box.innerHTML = `<div class="scene">${dieMarkup(v, size)}${[0, 1, 2].map((i) => `<div class="mcup" data-i="${i}">${MINI_CUP}</div>`).join('')}</div>`;
  const q = (c: string) => box.querySelector<HTMLElement>(c)!;
  const wrap = q('.diew'), cube = q('.die3'), shadow = q('.dsh');
  const cups = [...box.querySelectorAll<HTMLElement>('.mcup')];
  const [restX, restY] = REST[settings.diceFace];
  const LIFT = 0.58;
  sfx.shake(ms * 0.45);
  const x = [-22, 0, 22];
  // Swap 0 and 1, then 1 and 2, each cup arcing over the other; then the middle cup lifts away.
  const path: [number, number][][] = [
    [[x[0]!, 0], [x[1]!, -8], [x[1]!, 0], [x[1]!, 0], [x[2]!, 6], [x[2]!, 0]],
    [[x[1]!, 0], [x[0]!, 8], [x[0]!, 0], [x[0]!, 0], [x[0]!, 0], [x[0]!, 0]],
    [[x[2]!, 0], [x[2]!, 0], [x[2]!, 0], [x[2]!, 0], [x[1]!, -8], [x[1]!, 0]],
  ];
  cups.forEach((cup, i) => {
    const pts = path[i]!;
    const frames: Keyframe[] = pts.map(([px, py], k) => ({ transform: `translate(${px}px,${py}px)`, offset: (k / (pts.length - 1)) * (LIFT - 0.06) }));
    const lifts = pts[pts.length - 1]![0] === x[1];
    frames.push({ transform: `translate(${pts[pts.length - 1]![0]}px,0)`, offset: LIFT, opacity: 1 });
    frames.push({ transform: `translate(${pts[pts.length - 1]![0]}px,${lifts ? -44 : 0}px)`, offset: LIFT + 0.12, opacity: lifts ? 0 : 1 });
    frames.push({ transform: `translate(${pts[pts.length - 1]![0]}px,${lifts ? -44 : 0}px)`, opacity: lifts ? 0 : 0.0 });
    cup.animate(frames, { duration: ms, easing: 'ease-in-out', fill: 'forwards' });
  });
  wrap.animate([{ opacity: 0, transform: 'scale(.7)' }, { opacity: 0, transform: 'scale(.7)', offset: LIFT }, { opacity: 1, transform: 'scale(1.08)', offset: LIFT + 0.12 }, { transform: 'scale(1)' }], { duration: ms });
  shadow.animate([{ opacity: 0 }, { opacity: 0, offset: LIFT + 0.08 }, { opacity: 1 }], { duration: ms });
  const anim = cube.animate(spins(restX, restY), { duration: ms * (1 - LIFT), delay: ms * LIFT, fill: 'backwards' });
  setTimeout(() => sfx.land(v), ms * 0.86);
  return anim.finished.then(() => cups.forEach((c) => c.remove()));
}

/**
 * The dice gun. It swings in and aims; on the shot it kicks back with the muzzle rising, a flash and a
 * puff of smoke at the barrel; the die leaves the muzzle at bullet size and grows as it flies out toward
 * you along the barrel's line, lands, bounces twice and settles. The gun is sized to the die (3.2 times
 * as wide), so it always dwarfs what it fires; its muzzle is at (96%, 36.7%) of the gun.
 */
function gunRoll(box: HTMLElement, v: number, size: number, ms: number): Promise<void> {
  const gw = size * 3.2, gh = gw * 0.6;
  // The muzzle, relative to the box centre: up and to the left of where the die lands.
  const mx = -size * 0.42, my = -size * 0.32;
  const gunStyle = `width:${gw}px;height:${gh}px;left:calc(50% + ${mx - gw * 0.96}px);top:calc(50% + ${my - gh * 0.367}px);margin:0`;
  box.innerHTML = `<div class="scene">${dieMarkup(v, size)}<div class="gun" style="${gunStyle}">${GUN}<i class="flash"></i><i class="smoke"></i></div><i class="streak"></i></div>`;
  const q = (c: string) => box.querySelector<HTMLElement>(c)!;
  const wrap = q('.diew'), cube = q('.die3'), shadow = q('.dsh'), gun = q('.gun'), flash = q('.gun .flash'), smoke = q('.gun .smoke'), streak = q('.streak');
  const [restX, restY] = REST[settings.diceFace];
  const FIRE = 0.3;
  gun
    .animate(
      [
        { transform: 'translate(-40px,10px) rotate(14deg)', opacity: 0 },
        { transform: 'translate(0,0) rotate(-3deg)', opacity: 1, offset: 0.18, easing: 'cubic-bezier(.16,1,.3,1)' },
        { transform: 'translate(0,0) rotate(0deg)', offset: FIRE },
        // Recoil: kicked back along the barrel, muzzle up.
        { transform: 'translate(-12px,1px) rotate(-16deg)', offset: FIRE + 0.04, easing: 'cubic-bezier(.2,.8,.3,1)' },
        { transform: 'translate(-2px,0) rotate(-2deg)', offset: FIRE + 0.2 },
        { transform: 'translate(-2px,0) rotate(-2deg)', opacity: 1, offset: 0.66 },
        { transform: 'translate(-50px,14px) rotate(10deg)', opacity: 0 },
      ],
      { duration: ms },
    )
    .finished.finally(() => gun.remove());
  flash.animate([{ opacity: 0, transform: 'scale(.2)' }, { opacity: 0, transform: 'scale(.2)', offset: FIRE }, { opacity: 1, transform: 'scale(1.4) rotate(20deg)', offset: FIRE + 0.03 }, { opacity: 0, transform: 'scale(1.9) rotate(40deg)', offset: FIRE + 0.1 }, { opacity: 0 }], { duration: ms });
  smoke.animate([{ opacity: 0, transform: 'scale(.3)' }, { opacity: 0, transform: 'scale(.3)', offset: FIRE + 0.02 }, { opacity: 0.7, transform: 'translate(6px,-6px) scale(1)', offset: FIRE + 0.12 }, { opacity: 0, transform: 'translate(14px,-18px) scale(2)', offset: FIRE + 0.4 }, { opacity: 0 }], { duration: ms });
  const at = `translate(${mx}px,${my}px)`;
  streak.style.width = `${size * 0.8}px`;
  streak.animate([{ opacity: 0, transform: `${at} scaleX(0)` }, { opacity: 0, transform: `${at} scaleX(0)`, offset: FIRE }, { opacity: 0.9, transform: `${at} scaleX(1)`, offset: FIRE + 0.06 }, { opacity: 0, transform: `${at} scaleX(1.2)`, offset: FIRE + 0.16 }, { opacity: 0 }], { duration: ms });
  setTimeout(() => sfx.flare(), ms * FIRE);
  // The die: out of the muzzle at bullet size, growing as it comes at you, then two bounces.
  wrap.animate(
    [
      { transform: `translate(${mx}px,${my}px) scale(.18)`, opacity: 0 },
      { transform: `translate(${mx}px,${my}px) scale(.18)`, opacity: 0, offset: FIRE },
      { transform: `translate(${mx + size * 0.1}px,${my - 1}px) scale(.26)`, opacity: 1, offset: FIRE + 0.01 },
      { transform: 'translate(8px,-10px) scale(1.05)', offset: FIRE + 0.17, easing: 'cubic-bezier(.4,0,.9,.6)' },
      { transform: 'translate(10px,4px) scale(1.12,.86)', offset: 0.56 },
      { transform: 'translate(6px,-9px) scale(.98,1.03)', offset: 0.66 },
      { transform: 'translate(3px,2px) scale(1.05,.94)', offset: 0.76 },
      { transform: 'translate(1px,-2px)', offset: 0.85 },
      { transform: 'translate(0,0) scale(1)' },
    ],
    { duration: ms },
  );
  shadow.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1, offset: 0.56 }, { opacity: 1 }], { duration: ms });
  // Spinning fast out of the barrel.
  const anim = cube.animate(spins(restX, restY), { duration: ms * (1 - FIRE), delay: ms * FIRE, fill: 'backwards' });
  setTimeout(() => sfx.land(v), ms * 0.56);
  return anim.finished.then(() => undefined);
}

/** The plain toss: flicked up out of the box, tumbling, two bounces with a tracking shadow. */
function tossRoll(box: HTMLElement, v: number, size: number, ms: number): Promise<void> {
  box.innerHTML = dieMarkup(v, size);
  const wrap = box.querySelector<HTMLElement>('.diew')!;
  const cube = box.querySelector<HTMLElement>('.die3')!;
  const shadow = box.querySelector<HTMLElement>('.dsh')!;
  const [restX, restY] = REST[settings.diceFace];
  sfx.roll(ms);
  const opts = { duration: ms, easing: 'linear' as const };
  const anim = cube.animate(spins(restX, restY), opts);
  // Height: squat, flick up, fall, two shrinking bounces.
  wrap.animate(
    [
      { transform: 'translateY(0) scale(1.08,.9)' },
      { transform: 'translateY(-46px) scale(.96,1.05)', offset: 0.32, easing: 'cubic-bezier(.3,0,.7,1)' },
      { transform: 'translateY(0) scale(1.12,.86)', offset: 0.62, easing: 'cubic-bezier(.3,0,.5,1)' },
      { transform: 'translateY(-12px) scale(1,1)', offset: 0.76 },
      { transform: 'translateY(0) scale(1.05,.95)', offset: 0.88 },
      { transform: 'translateY(-3px)', offset: 0.94 },
      { transform: 'translateY(0) scale(1)' },
    ],
    opts,
  );
  shadow.animate(
    [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.45)', opacity: 0.35, offset: 0.32 }, { transform: 'scale(1)', opacity: 1, offset: 0.62 }, { transform: 'scale(.8)', opacity: 0.8, offset: 0.76 }, { transform: 'scale(1)', opacity: 1 }],
    opts,
  );
  setTimeout(() => sfx.land(v), ms * 0.62);
  return anim.finished.then(() => undefined);
}
