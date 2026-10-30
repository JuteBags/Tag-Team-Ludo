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

/** A tiny dice cup, opening down. */
const CUP = `<svg viewBox="0 0 40 44"><defs><linearGradient id="cupG" x1="0" x2="1"><stop offset="0" stop-color="#5a2d0c"/><stop offset=".45" stop-color="#a0571f"/><stop offset="1" stop-color="#4a2208"/></linearGradient></defs>
  <path d="M8,4 h24 l5,34 a3,3 0 0 1 -3,3.5 h-28 a3,3 0 0 1 -3,-3.5z" fill="url(#cupG)"/><rect x="2.5" y="35" width="35" height="7" rx="3.5" fill="#ffd23f" stroke="#a35a00" stroke-width="1.2"/>
  <rect x="7.5" y="2" width="25" height="5" rx="2.5" fill="#7a3d12"/><path d="M13,9 l-2,24" stroke="#fff" stroke-opacity=".25" stroke-width="3" stroke-linecap="round"/></svg>`;

/** Shows `v` in `box`: shaken in a cup (or tossed), then tumbling to rest. Resolves when it has landed. */
export function rollDie(box: HTMLElement, v: number, size: number, ms: number, style: ThrowStyle = settings.throwStyle): Promise<void> {
  box.innerHTML = dieMarkup(v, size);
  const wrap = box.querySelector<HTMLElement>('.diew')!;
  const cube = box.querySelector<HTMLElement>('.die3')!;
  const shadow = box.querySelector<HTMLElement>('.dsh')!;
  const [restX, restY] = REST[settings.diceFace];
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    sfx.land(v);
    return Promise.resolve();
  }
  // With a cup, the first part of the time is the shake; the die then tumbles out.
  const shake = style === 'cup' ? 0.42 : 0;
  const delay = ms * shake, dur = ms - delay;
  if (style === 'cup') {
    const cup = document.createElement('div');
    cup.className = 'cup';
    cup.innerHTML = CUP;
    box.appendChild(cup);
    sfx.shake(delay);
    cup.animate(
      [
        { transform: 'translateY(4px) rotate(0)', opacity: 1 },
        { transform: 'translate(-3px,2px) rotate(-13deg)', offset: 0.1 },
        { transform: 'translate(3px,3px) rotate(12deg)', offset: 0.2 },
        { transform: 'translate(-3px,1px) rotate(-11deg)', offset: 0.3 },
        { transform: 'translate(3px,3px) rotate(10deg)', offset: 0.4 },
        { transform: 'translate(-2px,2px) rotate(-8deg)', offset: 0.5 },
        { transform: 'translate(2px,3px) rotate(6deg)', offset: 0.6 },
        { transform: 'translateY(4px) rotate(0)', offset: 0.68 },
        // Lift and tip away, out of sight.
        { transform: 'translate(10px,-30px) rotate(38deg)', opacity: 1, offset: 0.86 },
        { transform: 'translate(16px,-40px) rotate(50deg)', opacity: 0 },
      ],
      { duration: delay / 0.68, easing: 'ease-in-out' },
    ).finished.finally(() => cup.remove());
    wrap.animate([{ opacity: 0 }, { opacity: 0, offset: 0.99 }, { opacity: 1 }], { duration: delay });
  } else {
    sfx.roll(ms);
  }
  const spinX = 720 + 90 * Math.floor(Math.random() * 3);
  const spinY = 540 + 90 * Math.floor(Math.random() * 3);
  const opts = { duration: dur, delay, easing: 'linear' as const, fill: 'backwards' as const };
  const anim = cube.animate(
    [
      { transform: `rotateX(${restX + spinX}deg) rotateY(${restY + spinY}deg) rotateZ(200deg)` },
      { transform: `rotateX(${restX + 200}deg) rotateY(${restY + 150}deg) rotateZ(60deg)`, offset: 0.55, easing: 'cubic-bezier(.3,.6,.4,1)' },
      { transform: `rotateX(${restX + 18}deg) rotateY(${restY + 12}deg)`, offset: 0.8 },
      { transform: `rotateX(${restX}deg) rotateY(${restY}deg)` },
    ],
    opts,
  );
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
  setTimeout(() => sfx.land(v), delay + dur * 0.62);
  return Promise.race([anim.finished.then(() => undefined), new Promise<void>((r) => setTimeout(r, ms + 80))]);
}
