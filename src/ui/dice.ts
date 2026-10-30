// CSS 3D die with rounded corners. The cube is rebuilt with the rolled value on the face that counts
// (top or front, a player setting), then thrown and tumbled into a resting pose that shows that face
// largest, with a gold rim on it so there is never a doubt which face is the roll.
import { settings, type DiceFace, type ThrowStyle } from './settings';
import { sfx } from './sfx';

const PIPS: Record<number, number[]> = { 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
/** Resting tilt for each counting face: the counting face is the big one you see. */
const REST: Record<DiceFace, [number, number]> = { top: [-56, -24], front: [-16, -22] };

const face = (v: number, cls: string, tf: string, win: boolean) =>
  `<div class="f ${cls}${win ? ' win' : ''}" style="transform:${tf}">${Array.from({ length: 9 }, (_, k) => (PIPS[v]!.includes(k) ? `<i class="p${v === 1 || v === 6 ? ' r' : ''}"></i>` : '<i></i>')).join('')}</div>`;

export function dieMarkup(v: number, size: number, rx?: number, ry?: number, mode: DiceFace = settings.diceFace): string {
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
  return `<div class="diew" style="width:${size}px;height:${size}px;perspective:${size * 7}px"><div class="dsh"></div><div class="die3" style="width:${size}px;height:${size}px;transform:rotateX(${rx ?? restX}deg) rotateY(${ry ?? restY}deg)">${core}
  ${face(7 - fr, 'bk', tf.bk, false)}${face(7 - rt, 'lf', tf.lf, false)}${face(7 - tp, 'bt', tf.bt, false)}
  ${face(tp, 'tp', tf.tp, mode === 'top')}${face(rt, 'rt', tf.rt, false)}${face(fr, 'fr', tf.fr, mode === 'front')}</div></div>`;
}

/** A tiny dice cup, upright: open at the top, gold rim. */
const CUP = `<svg viewBox="0 0 40 46"><defs><linearGradient id="cupG" x1="0" x2="1"><stop offset="0" stop-color="#4a2208"/><stop offset=".42" stop-color="#a65d22"/><stop offset="1" stop-color="#3f1c06"/></linearGradient></defs>
  <path d="M3,8 h34 l-5,33 a3,3 0 0 1 -3,2.6 h-18 a3,3 0 0 1 -3,-2.6z" fill="url(#cupG)"/>
  <ellipse cx="20" cy="8" rx="17.5" ry="5" fill="#ffd23f" stroke="#a35a00" stroke-width="1.2"/><ellipse cx="20" cy="8" rx="14" ry="3.2" fill="#2a1204"/>
  <path d="M10,13 l3,24" stroke="#fff" stroke-opacity=".22" stroke-width="3" stroke-linecap="round"/></svg>`;

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
export function rollDie(box: HTMLElement, v: number, size: number, ms: number, style: ThrowStyle = settings.throwStyle): Promise<void> {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    box.innerHTML = dieMarkup(v, size);
    sfx.land(v);
    return Promise.resolve();
  }
  const done = style === 'cup' ? cupRoll(box, v, size, ms) : tossRoll(box, v, size, ms);
  return Promise.race([done, new Promise<void>((r) => setTimeout(r, ms + 80))]);
}

/**
 * The cup throw. The camera starts pulled back inside the dice box; the cup is shaken up and down,
 * tipped toward the mat to throw the die out, the die rolls and bounces to a stop, and the camera
 * pushes in to the usual close view.
 */
function cupRoll(box: HTMLElement, v: number, size: number, ms: number): Promise<void> {
  box.innerHTML = `<div class="scene">${dieMarkup(v, size)}<div class="cup">${CUP}</div></div>`;
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
