// CSS 3D die. The cube is rebuilt with the rolled face in front, then tumbled into place.

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

/** Shows `v` in `box` with a tumble. Resolves when the die has landed. */
export function rollDie(box: HTMLElement, v: number, size: number, ms: number): Promise<void> {
  box.innerHTML = dieMarkup(v, size);
  const cube = box.querySelector<HTMLElement>('.die3')!;
  const spinX = 720 + 90 * Math.floor(Math.random() * 3);
  const spinY = 540 + 90 * Math.floor(Math.random() * 3);
  const anim = cube.animate(
    [
      { transform: `translateY(-14px) rotateX(${REST_X + spinX}deg) rotateY(${REST_Y + spinY}deg) rotateZ(160deg)` },
      { transform: `translateY(-6px) rotateX(${REST_X + 90}deg) rotateY(${REST_Y + 40}deg) rotateZ(20deg)`, offset: 0.7 },
      { transform: `rotateX(${REST_X}deg) rotateY(${REST_Y}deg)` },
    ],
    { duration: ms, easing: 'cubic-bezier(.25,.7,.35,1)' },
  );
  box.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.12)', offset: 0.3 }, { transform: 'scale(1)' }], { duration: ms });
  return Promise.race([anim.finished.then(() => undefined), new Promise<void>((r) => setTimeout(r, ms + 80))]);
}
