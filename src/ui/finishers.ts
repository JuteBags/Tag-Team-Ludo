// Kill finishers (#39): each colour finishes a kill its own way, drawn in SVG over the board, and takes
// the victim out: Green's shot blows it back, Red's guillotine cuts it in two, Blue's wave sweeps it
// away toward its base, Yellow's lightning burns it to ash. The board then puts the victim back in its
// base (boardView.animateMove). Only the look: the engine has already decided the kill.
import type { Color } from '../engine';
import { sfx } from './sfx';

const NS = 'http://www.w3.org/2000/svg';
type Pt = [number, number];

/** A captured pawn: its art (animated in the pawn's own units), its base, and the pawn's scale. */
export interface Victim {
  art: SVGGElement;
  home: Pt;
  s: number;
}

function el(layer: SVGGElement, html: string): SVGGElement {
  const g = document.createElementNS(NS, 'g');
  g.innerHTML = html;
  layer.appendChild(g);
  return g;
}

const run = (g: Element, frames: Keyframe[], ms: number, opts: KeyframeAnimationOptions = {}) =>
  g.animate(frames, { duration: ms, fill: 'both', easing: 'cubic-bezier(.2,.8,.3,1)', ...opts }).finished;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Board units to a victim's own units (its art is scaled by the pawn's scale). */
const local = (v: Victim, dx: number, dy: number) => [dx / v.s, dy / v.s] as const;

/** Shakes the board's inner panel (the frame itself is busy zooming). */
function shake(layer: SVGGElement, px: number, ms: number) {
  layer.ownerSVGElement?.closest<HTMLElement>('.binner')?.animate(
    [{ transform: 'none' }, { transform: `translate(${-px}px,${px * 0.6}px)` }, { transform: `translate(${px * 0.8}px,${-px * 0.7}px)` }, { transform: `translate(${-px * 0.5}px,${px * 0.4}px)` }, { transform: `translate(${px * 0.3}px,0)` }, { transform: 'none' }],
    { duration: ms, easing: 'cubic-bezier(.2,.8,.3,1)' },
  );
}

/** Green: a bolt fired from where the attacker set off; the victim is blown back along the shot, spinning. */
async function shot(layer: SVGGElement, from: Pt, at: Pt, ms: number, victims: Victim[]) {
  const [ax, ay] = from, [bx, by] = at;
  const ang = Math.atan2(by - ay, bx - ax);
  const len = Math.hypot(bx - ax, by - ay);
  const g = el(layer, `<g transform="translate(${ax} ${ay}) rotate(${(ang * 180) / Math.PI})">
    <circle class="fl" r="34" fill="#eaffc2"/>
    <rect class="bolt" x="0" y="-9" width="${len}" height="18" rx="9" fill="#5dff4a"/>
    <rect class="core" x="0" y="-3.5" width="${len}" height="7" rx="3.5" fill="#fff"/></g>
    <g transform="translate(${bx} ${by}) scale(2.6)"><path class="hit" d="M0,-22 L5,-5 22,0 5,5 0,22 -5,5 -22,0 -5,-5Z" fill="#eaffc2"/></g>`);
  sfx.flare();
  const q = (s: string) => g.querySelector(s)!;
  void run(q('.fl'), [{ transform: 'scale(.2)', opacity: 1 }, { transform: 'scale(1.6)', opacity: 0 }], ms * 0.4);
  void run(q('.bolt'), [{ transform: 'scaleX(0)', opacity: 1 }, { transform: 'scaleX(1)', opacity: 1, offset: 0.3 }, { transform: 'scaleX(1)', opacity: 0 }], ms * 0.7, { easing: 'linear' });
  void run(q('.core'), [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)', offset: 0.3 }, { transform: 'scaleX(1)', opacity: 0 }], ms * 0.7, { easing: 'linear' });
  void run(q('.hit'), [{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(0)', opacity: 0, offset: 0.25 }, { transform: 'scale(1.5) rotate(45deg)', opacity: 1, offset: 0.4 }, { transform: 'scale(2) rotate(90deg)', opacity: 0 }], ms * 0.7);
  await wait(ms * 0.25);
  sfx.bust();
  shake(layer, 6, 300);
  // Blown back along the line of fire, spinning, and gone.
  await Promise.all(
    victims.map((v) => {
      const [dx, dy] = local(v, Math.cos(ang) * 110, Math.sin(ang) * 110);
      return run(v.art, [{ transform: 'none', opacity: 1 }, { transform: `translate(${dx * 0.5}px,${dy * 0.5 - 12}px) rotate(300deg)`, opacity: 1, offset: 0.5 }, { transform: `translate(${dx}px,${dy}px) rotate(620deg) scale(.6)`, opacity: 0 }], ms * 0.7, { easing: 'cubic-bezier(.1,.7,.3,1)' });
    }),
  );
  g.remove();
}

/** Red: a guillotine blade drops onto the victim and cuts it clean in two; the halves fall apart. */
async function guillotine(layer: SVGGElement, at: Pt, ms: number, victims: Victim[]) {
  const [x, y] = at;
  const g = el(layer, `<g transform="translate(${x} ${y}) scale(3.4)">
    <g class="bl"><rect x="-26" y="-118" width="5" height="96" fill="#6b4422"/><rect x="21" y="-118" width="5" height="96" fill="#6b4422"/><rect x="-28" y="-122" width="56" height="7" rx="2" fill="#4a2e16"/>
    <g class="blade"><path d="M-21,-60 H21 V-40 L-21,-28Z" fill="#cfd6e0" stroke="#3a4252" stroke-width="1.6"/><path d="M-21,-31 L21,-43" stroke="#fff" stroke-width="1.6"/><rect x="-6" y="-66" width="12" height="7" fill="#3a4252"/></g></g>
    <path class="slash" d="M-30,4 L30,-12" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity="0"/></g>`);
  const q = (s: string) => g.querySelector(s)!;
  // The frame drops in, then the blade falls along it.
  await run(q('.bl'), [{ transform: 'translateY(-50px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], ms * 0.25);
  await run(q('.blade'), [{ transform: 'translateY(0)' }, { transform: 'translateY(40px)' }], ms * 0.14, { easing: 'cubic-bezier(.8,0,1,.6)' });
  sfx.bust();
  sfx.kill(2);
  shake(layer, 10, 380);
  void run(q('.slash'), [{ opacity: 1, transform: 'scaleX(.2)' }, { opacity: 0, transform: 'scaleX(1.4)' }], ms * 0.3);
  // Cut in two: two clipped copies of the pawn fall apart while the whole pawn hides.
  const parts = victims.flatMap((v, i) => {
    const id = `cut${++cuts}_${i}`;
    const parent = v.art.parentNode as SVGGElement;
    const defs = document.createElementNS(NS, 'g');
    defs.innerHTML = `<clipPath id="${id}a"><polygon points="-40,-40 40,-40 40,-6 -40,6"/></clipPath><clipPath id="${id}b"><polygon points="-40,6 40,-6 40,40 -40,40"/></clipPath>`;
    parent.appendChild(defs);
    v.art.style.opacity = '0';
    const half = (clip: string, top: boolean) => {
      const c = v.art.cloneNode(true) as SVGGElement;
      c.style.opacity = '1';
      c.setAttribute('clip-path', `url(#${clip})`);
      parent.appendChild(c);
      void run(c, [{ transform: 'none' }, { transform: top ? 'translate(-3px,-2px) rotate(-6deg)' : 'translate(2px,1px)', offset: 0.2 }, { transform: top ? 'translate(-22px,14px) rotate(-70deg)' : 'translate(16px,10px) rotate(28deg)', opacity: 1, offset: 0.75 }, { transform: top ? 'translate(-26px,18px) rotate(-80deg)' : 'translate(18px,12px) rotate(30deg)', opacity: 0 }], ms * 0.6, { easing: 'cubic-bezier(.5,0,.7,1)' });
      return c;
    };
    return [half(`${id}a`, true), half(`${id}b`, false), defs];
  });
  void run(q('.bl'), [{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0, transform: 'translateY(-30px)' }], ms * 0.6);
  await wait(ms * 0.62);
  parts.forEach((p) => p.remove());
  g.remove();
}

/** Blue: a wave rolls in and sweeps the victim away toward its base, tumbling in the water. */
async function wave(layer: SVGGElement, at: Pt, ms: number, victims: Victim[]) {
  const [x, y] = at;
  // The wave rolls toward the (first) victim's base.
  const [hx, hy] = victims[0]?.home ?? [x + 100, y];
  const ang = Math.atan2(hy - y, hx - x);
  const g = el(layer, `<g transform="translate(${x} ${y}) rotate(${(ang * 180) / Math.PI})"><g class="wv">
    <path d="M-70,14 C-50,-34 -10,-46 14,-22 C2,-30 -12,-22 -8,-8 C-2,4 12,4 22,-4 C24,8 12,18 -70,18Z" fill="#2f8fff"/>
    <path d="M-80,18 C-60,-6 -30,-10 -6,4 L-6,20 -80,20Z" fill="#1a63d6"/>
    <path d="M-60,10 C-44,-26 -14,-36 6,-20" fill="none" stroke="#bfe8ff" stroke-width="4" stroke-linecap="round"/>
    <circle cx="16" cy="-20" r="3" fill="#e6f7ff"/><circle cx="22" cy="-12" r="2.4" fill="#e6f7ff"/><circle cx="10" cy="-28" r="2" fill="#e6f7ff"/></g></g>`);
  const q = (s: string) => g.querySelector(s)!;
  sfx.bubbles();
  const dist = Math.min(260, Math.hypot(hx - x, hy - y));
  // In from behind the victim, then on toward its base, carrying it.
  void run(q('.wv'), [{ transform: 'translateX(-90px) scale(1.8)', opacity: 0 }, { transform: 'translateX(-10px) scale(3)', opacity: 1, offset: 0.3 }, { transform: `translateX(${dist}px) scale(3.2,2.6)`, opacity: 1, offset: 0.85 }, { transform: `translateX(${dist + 30}px) scale(3.4,1.4)`, opacity: 0 }], ms, { easing: 'cubic-bezier(.4,0,.6,1)' });
  await wait(ms * 0.28);
  shake(layer, 5, 300);
  await Promise.all(
    victims.map((v) => {
      const [dx, dy] = local(v, Math.cos(ang) * dist, Math.sin(ang) * dist);
      return run(v.art, [{ transform: 'none', opacity: 1 }, { transform: `translate(${dx * 0.4}px,${dy * 0.4 - 18}px) rotate(160deg)`, opacity: 1, offset: 0.4 }, { transform: `translate(${dx}px,${dy}px) rotate(480deg) scale(.7)`, opacity: 0 }], ms * 0.65, { easing: 'cubic-bezier(.4,0,.6,1)' });
    }),
  );
  await wait(ms * 0.08);
  g.remove();
}

/** Yellow: the sky goes dark, three forked bolts strike, and the victim burns to a pile of ash. */
async function lightning(layer: SVGGElement, at: Pt, ms: number, victims: Victim[]) {
  const [x, y] = at;
  const bolt = (dx: number, rot: number, w: number) => `<g transform="translate(${dx} 0) rotate(${rot})"><path class="bolt" d="M-10,-200 L12,-130 -8,-122 16,-56 -6,-50 6,0 M12,-130 L34,-100 26,-96 44,-70 M16,-56 L-14,-30" fill="none" stroke="#fffbd0" stroke-width="${w + 6}" stroke-linejoin="round" stroke-linecap="round" opacity="0"/><path class="bolt" d="M-10,-200 L12,-130 -8,-122 16,-56 -6,-50 6,0 M12,-130 L34,-100 26,-96 44,-70 M16,-56 L-14,-30" fill="none" stroke="#ffd23f" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round" opacity="0"/></g>`;
  const embers = Array.from({ length: 12 }, (_, i) => `<circle class="em" cx="${(i % 6) * 6 - 15}" cy="0" r="${1.4 + (i % 3) * 0.6}" fill="${i % 2 ? '#ff9a1f' : '#ffd23f'}" opacity="0"/>`).join('');
  const sky = el(layer, '<rect width="600" height="600" fill="#0a0820"/>');
  const g = el(layer, `<g transform="translate(${x} ${y}) scale(2)"><circle class="glow" r="46" fill="#fff6b0" opacity="0"/>${bolt(-26, -8, 3)}${bolt(24, 10, 3)}${bolt(0, 0, 5)}
    <g class="ash" opacity="0"><ellipse cx="0" cy="9" rx="13" ry="4.5" fill="#2a241e"/><ellipse cx="-2" cy="6" rx="8" ry="3.6" fill="#4a4038"/><ellipse cx="2" cy="4" rx="4" ry="2.2" fill="#6a6058"/></g>
    <g class="smoke" opacity="0"><circle cx="-4" cy="-6" r="7" fill="#6a6a72"/><circle cx="5" cy="-14" r="9" fill="#55555e"/><circle cx="-2" cy="-26" r="11" fill="#45454d"/></g>${embers}</g>`);
  const q = (s: string) => g.querySelector(s)!;
  void run(sky, [{ opacity: 0 }, { opacity: 0.75, offset: 0.2 }, { opacity: 0.75, offset: 0.7 }, { opacity: 0 }], ms, { easing: 'linear' }).then(() => sky.remove());
  await wait(ms * 0.18);
  sfx.flare();
  sfx.bust();
  shake(layer, 8, 380);
  [...g.querySelectorAll('.bolt')].forEach((b, i) => void run(b, [{ opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 0.15, offset: 0.18 }, { opacity: 1, offset: 0.28 }, { opacity: 0.6, offset: 0.55 }, { opacity: 0 }], ms * 0.45, { easing: 'linear', delay: Math.floor(i / 2) * 70 }));
  void run(q('.glow'), [{ opacity: 0, transform: 'scale(.2)' }, { opacity: 1, transform: 'scale(1.4)', offset: 0.2 }, { opacity: 0, transform: 'scale(2.4)' }], ms * 0.45);
  // Charred black, then it crumbles down into ash while it smokes and embers rise.
  void run(q('.ash'), [{ opacity: 0 }, { opacity: 0, offset: 0.45 }, { opacity: 1, offset: 0.6 }, { opacity: 1, offset: 0.9 }, { opacity: 0 }], ms * 1.05);
  void run(q('.smoke'), [{ opacity: 0, transform: 'scale(.5)' }, { opacity: 0, transform: 'scale(.5)', offset: 0.35 }, { opacity: 0.8, transform: 'translateY(-10px) scale(1)', offset: 0.6 }, { opacity: 0, transform: 'translateY(-40px) scale(1.6)' }], ms * 1.05);
  g.querySelectorAll('.em').forEach((e, i) => void run(e, [{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1, transform: 'translate(0,0)', offset: 0.45 }, { opacity: 0, transform: `translate(${(i % 2 ? 1 : -1) * (4 + i)}px,${-30 - i * 4}px)` }], ms, { delay: i * 25 }));
  await Promise.all(
    victims.map((v) =>
      run(v.art, [{ filter: 'none', transform: 'none', opacity: 1 }, { filter: 'brightness(.12) saturate(0)', transform: 'none', opacity: 1, offset: 0.35 }, { filter: 'brightness(.12) saturate(0)', transform: 'translateY(4px) scale(1.15,.4)', opacity: 0.8, offset: 0.75 }, { filter: 'brightness(.12) saturate(0)', transform: 'translateY(8px) scale(1.3,.05)', opacity: 0 }], ms * 0.7, { easing: 'ease-in' }),
    ),
  );
  await wait(ms * 0.35);
  g.remove();
}

let spots = 0;
let cuts = 0;

/**
 * Plays the attacker colour's finisher at the victim's square and takes the victim out. `from` is where
 * the attacker set off (Green fires from there). Resolves when it's done; the board then puts the victim
 * back in its base.
 */
export async function playFinisher(layer: SVGGElement, attacker: Color, from: Pt, at: Pt, ms = 560, victims: Victim[] = []): Promise<void> {
  // A spotlight: the board darkens around the hit for the length of the finisher.
  const id = `spot${++spots}`;
  const dim = el(layer, `<defs><radialGradient id="${id}" cx="${at[0]}" cy="${at[1]}" r="230" gradientUnits="userSpaceOnUse"><stop offset=".12" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".72"/></radialGradient></defs><rect width="600" height="600" fill="url(#${id})"/>`);
  void run(dim, [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], ms + 160, { easing: 'linear' });
  // The camera: zooms in on the hit, holds through the finisher, then pulls back out.
  const frame = layer.ownerSVGElement?.closest<HTMLElement>('.bframe');
  const svg = layer.ownerSVGElement;
  if (frame && svg) {
    const k = svg.clientWidth / 600;
    const dx = (at[0] - 300) * k, dy = (at[1] - 300) * k;
    frame.animate(
      [
        { translate: '0 0', scale: '1' },
        { translate: `${-dx * 0.55}px ${-dy * 0.55}px`, scale: '1.55', offset: 0.22 },
        { translate: `${-dx * 0.55}px ${-dy * 0.55}px`, scale: '1.62', offset: 0.78 },
        { translate: '0 0', scale: '1' },
      ],
      { duration: ms + 420, easing: 'cubic-bezier(.3,.7,.3,1)' },
    );
  }
  const fx =
    attacker === 'green' ? shot(layer, from, at, ms, victims)
    : attacker === 'red' ? guillotine(layer, at, ms, victims)
    : attacker === 'blue' ? wave(layer, at, ms, victims)
    : lightning(layer, at, ms, victims);
  await fx;
  // The victim stays hidden until the board puts it back in its base.
  for (const v of victims) {
    v.art.getAnimations().forEach((a) => a.cancel());
    v.art.style.opacity = '0';
  }
  await wait(200);
  setTimeout(() => dim.remove(), 180);
}
