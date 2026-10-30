// CSS 3D die. The cube is rebuilt with the rolled face in front, then tumbled into place.
import { sfx } from './sfx';

const PIPS: Record<number, number[]> = { 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const REST_X = -24;
const REST_Y = -30;

const face = (v: number, cls: string, tf: string) =>
  `<div class="f ${cls}" style="transform:${tf}">${Array.from({ length: 9 }, (_, k) => (PIPS[v]!.includes(k) ? `<i class="p${v === 1 ? ' r' : ''}"></i>` : '<i></i>')).join('')}</div>`;

export function dieMarkup(v: number, size: number, rx = REST_X, ry = REST_Y): string {
  const h = size / 2;
  const rest = [1, 2, 3, 4, 5, 6].filter((n) => n !== v && n !== 7 - v);
  const t = rest[0]!;
  const r = rest.find((n) => n !== t && n !== 7 - t)!;
  return `<div class="diew" style="width:${size}px;height:${size}px;perspective:${size * 7}px"><div class="dsh"></div><div class="die3" style="width:${size}px;height:${size}px;transform:rotateX(${rx}deg) rotateY(${ry}deg)">
  ${face(7 - v, 'bk', `rotateY(180deg) translateZ(${h}px)`)}${face(7 - r, 'lf', `rotateY(-90deg) translateZ(${h}px)`)}${face(7 - t, 'bt', `rotateX(-90deg) translateZ(${h}px)`)}
  ${face(t, 'tp', `rotateX(90deg) translateZ(${h}px)`)}${face(r, 'rt', `rotateY(90deg) translateZ(${h}px)`)}${face(v, 'fr', `translateZ(${h}px)`)}</div></div>`;
}

/**
 * Shows `v` in `box` with a toss: the die is flicked up out of its box tumbling, falls, and lands
 * with two bounces while its shadow tracks the height. Resolves when it has landed.
 */
export function rollDie(box: HTMLElement, v: number, size: number, ms: number): Promise<void> {
  box.innerHTML = dieMarkup(v, size);
  const wrap = box.querySelector<HTMLElement>('.diew')!;
  const cube = box.querySelector<HTMLElement>('.die3')!;
  const shadow = box.querySelector<HTMLElement>('.dsh')!;
  sfx.roll(ms);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    sfx.land(v);
    return Promise.resolve();
  }
  const spinX = 720 + 90 * Math.floor(Math.random() * 3);
  const spinY = 540 + 90 * Math.floor(Math.random() * 3);
  const opts = { duration: ms, easing: 'linear' as const };
  const anim = cube.animate(
    [
      { transform: `rotateX(${REST_X + spinX}deg) rotateY(${REST_Y + spinY}deg) rotateZ(200deg)` },
      { transform: `rotateX(${REST_X + 200}deg) rotateY(${REST_Y + 150}deg) rotateZ(60deg)`, offset: 0.55, easing: 'cubic-bezier(.3,.6,.4,1)' },
      { transform: `rotateX(${REST_X + 18}deg) rotateY(${REST_Y + 12}deg)`, offset: 0.8 },
      { transform: `rotateX(${REST_X}deg) rotateY(${REST_Y}deg)` },
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
  setTimeout(() => sfx.land(v), ms * 0.62);
  return Promise.race([anim.finished.then(() => undefined), new Promise<void>((r) => setTimeout(r, ms + 80))]);
}
