// Kill finishers (#39, #147): each colour finishes a kill its own way, drawn in SVG on the board, and
// takes the victim out: Green's earthquake swallows it, Red's guillotine cuts it in two, Blue's wave sweeps
// it away toward its base, Yellow's lightning burns it to ash. When a pair captures a pair (two victims,
// "full" finishers only) the effect happens for each pawn: the blade falls twice, two waves roll, a huge
// bolt forks onto both, the earth splits wide and both fall in. The board then puts the victims back in
// their bases (boardView.animateMove). Only the look: the engine has already decided the kill. Everything
// animated is transform and opacity (#98), but Yellow's charring filter.
import type { Color } from '../engine';
import { sfx } from './sfx';

const NS = 'http://www.w3.org/2000/svg';
type Pt = [number, number];

/** A captured pawn: its art (animated in the pawn's own units), where it stands, its base, and the pawn's scale. */
export interface Victim {
  art: SVGGElement;
  at: Pt;
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
/** A pawn the finisher moves without taking it out (the attacker): its art, where it stands, its scale. */
export type Piece = Omit<Victim, 'home'>;

const local = (v: Piece, dx: number, dy: number) => [dx / v.s, dy / v.s] as const;

/** Shakes the board's inner panel (the frame itself is busy zooming). */
function shake(layer: SVGGElement, px: number, ms: number) {
  layer.ownerSVGElement?.closest<HTMLElement>('.binner')?.animate(
    [{ transform: 'none' }, { transform: `translate(${-px}px,${px * 0.6}px)` }, { transform: `translate(${px * 0.8}px,${-px * 0.7}px)` }, { transform: `translate(${-px * 0.5}px,${px * 0.4}px)` }, { transform: `translate(${px * 0.3}px,0)` }, { transform: 'none' }],
    { duration: ms, easing: 'cubic-bezier(.2,.8,.3,1)' },
  );
}

/** A few jagged crack lines out from the centre, `n` of them up to `len` long, deterministic per kill. */
function cracks(n: number, len: number, seed: number): string {
  let r = seed;
  const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  let out = '';
  for (let i = 0; i < n; i++) {
    const ang = (360 / n) * i + rnd() * 26 - 13;
    const l = len * (0.65 + rnd() * 0.35);
    let d = 'M0,0';
    for (let k = 1; k <= 5; k++) d += ` L${((l * k) / 5).toFixed(1)},${((rnd() - 0.5) * l * 0.22).toFixed(1)}`;
    // a side branch
    const b = l * (0.35 + rnd() * 0.25);
    d += ` M${b.toFixed(1)},0 L${(b + l * 0.25).toFixed(1)},${((rnd() < 0.5 ? -1 : 1) * l * 0.2).toFixed(1)}`;
    out += `<g transform="rotate(${ang.toFixed(1)})"><path class="ck" d="${d}" fill="none" stroke="#1b120a" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  }
  return out;
}
let quakes = 0;

/** The two layers a finisher draws in: `under` sits between the board and the pieces, `top` above everything. */
export interface Layers {
  under: SVGGElement;
  top: SVGGElement;
}

/**
 * Green: the earth splits open. The board shakes, cracks race out from under the victim, and the ground opens
 * into a pit; the victim tips over the edge and sinks, shrinking and darkening, behind the pit's near rim; the
 * pit closes behind it. `big` (a pair): a wider pit, more cracks, a bigger shake and dust cloud, and both fall
 * in, one after the other.
 *
 * Depth comes from the layers (#147): the cracks, the pit's rim, its far wall and its dark bottom go `under`
 * the pieces; the near rim's lip, the dust and the chips go on `top`. While a victim falls, its group is
 * clipped to what stays in view (everything above the pit's centre line, plus the opening), so it disappears
 * behind the lip.
 */
async function earthquake(layers: Layers, at: Pt, ms: number, victims: Victim[], big: boolean, tilted: boolean, hunters: Piece[]) {
  const [x, y] = at;
  const k = big ? 2 : 1.35;
  // The pit is a round hole in the ground seen at an angle: flatter on the tilted board.
  const f = tilted ? 0.45 : 0.55;
  const R = 26, r = 21; // the outer rim and the opening, before the scale k
  // The attacker landed on the victim's square: it hops back onto the far rim (or the near side, at the board's
  // top edge) to watch the victim fall, and hops back once the pit has closed. Its shadow and rings fade while
  // it's off its square.
  const back = y - R * k * f - 30 > 24 ? -(R * k * f + 30) : R * k * f + 18;
  const aside = (h: Piece, i: number) => local(h, (i - (hunters.length - 1) / 2) * 14, back);
  const restOf = (p: Piece) => [...(p.art.parentNode as SVGGElement).children].filter((c) => c !== p.art);
  // Nearer the viewer draws later: on the far rim the attacker goes behind the victims.
  if (back < 0) for (const v of victims) v.art.parentNode?.parentNode?.appendChild(v.art.parentNode);
  hunters.forEach((h, i) => {
    const [dx, dy] = aside(h, i);
    restOf(h).forEach((c) => void run(c, [{ opacity: 1 }, { opacity: 0 }], ms * 0.06));
    void run(h.art, [{ transform: 'none' }, { transform: `translate(${dx * 0.5}px,${dy * 0.5 - 16}px)`, offset: 0.5 }, { transform: `translate(${dx}px,${dy}px)` }], ms * 0.16, { easing: 'cubic-bezier(.3,.7,.4,1)' });
  });
  const id = `pit${++quakes}`;
  const dust = Array.from({ length: big ? 9 : 6 }, (_, i) => {
    const a = (i / (big ? 9 : 6)) * Math.PI * 2;
    return `<circle class="du" cx="${(Math.cos(a) * 16 * k).toFixed(1)}" cy="${(Math.sin(a) * 7 * k).toFixed(1)}" r="${(9 + (i % 3) * 3) * k}" fill="${i % 2 ? '#c8b49a' : '#a8916f'}" opacity="0"/>`;
  }).join('');
  const chips = Array.from({ length: big ? 10 : 6 }, (_, i) => `<path class="ch" d="M-3,-2 L2,-3 3,2 -2,3Z" fill="${i % 2 ? '#6b4a2a' : '#8a6a44'}" opacity="0"/>`).join('');
  // Under the pieces: the cracks; a soft ring of shade; the earth rim, lit on its far edge; the opening, its far
  // wall lit and its bottom dark (the bottom shows on the near side, as in a real hole seen from above).
  const ground = el(
    layers.under,
    `<defs><linearGradient id="${id}w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a2e15"/><stop offset=".38" stop-color="#22140a"/><stop offset=".62" stop-color="#070403"/><stop offset="1" stop-color="#000"/></linearGradient></defs>
    <g transform="translate(${x} ${y})"><g class="cks">${cracks(big ? 9 : 6, 46 * k, quakes * 7919)}</g>
    <g class="hole" transform="scale(0)"><ellipse cy="2" rx="${R + 7}" ry="${(R + 7) * f}" fill="#000" opacity=".28"/>
    <ellipse rx="${R}" ry="${R * f}" fill="#6b4624"/><path d="M${-R},0 A${R},${R * f} 0 0 1 ${R},0" fill="none" stroke="#a07648" stroke-width="2.2"/>
    <ellipse rx="${r}" ry="${r * f}" fill="url(#${id}w)"/><ellipse cy="${r * f * 0.35}" rx="${r * 0.72}" ry="${r * f * 0.5}" fill="#000"/></g></g>`,
  );
  // On top: the near rim's lip (the band between the rim and the opening, below the centre line), then dust and chips.
  const lip = `M${-R},0 A${R},${R * f} 0 0 0 ${R},0 L${r},0 A${r},${r * f} 0 0 1 ${-r},0Z`;
  const front = el(
    layers.top,
    `<g transform="translate(${x} ${y})"><g class="lip" transform="scale(0)"><path d="${lip}" fill="#6b4624"/>
    <path d="M${r},0 A${r},${r * f} 0 0 1 ${-r},0" fill="none" stroke="#9a6e40" stroke-width="1.8"/><path d="M${-R},0 A${R},${R * f} 0 0 0 ${R},0" fill="none" stroke="#3f2810" stroke-width="1.6"/></g>
    ${dust}${chips}</g>`,
  );
  const q = (g: Element, sel: string) => g.querySelector(sel)!;
  const all = (sel: string) => [...front.querySelectorAll(sel)];
  sfx.quake(big);
  shake(layers.top, big ? 15 : 9, ms * (big ? 0.6 : 0.45));
  // The cracks race out (each grows from the centre along its own line).
  ground.querySelectorAll('.ck').forEach((c, i) => void run(c, [{ transform: 'scaleX(0)', opacity: 1 }, { transform: 'scaleX(1)', opacity: 1, offset: 0.7 }, { transform: 'scaleX(1)', opacity: 1 }], ms * 0.28, { delay: (i % 3) * ms * 0.02, easing: 'cubic-bezier(.2,.9,.3,1)' }));
  await wait(ms * 0.22);
  // The ground splits: the pit opens (its rim and its lip together) with a crack, dust puffs up and chips fly.
  sfx.crack(big);
  const open: Keyframe[] = [{ transform: 'scale(0)' }, { transform: `scale(${k * 1.12})`, offset: 0.55 }, { transform: `scale(${k})` }];
  for (const g of [q(ground, '.hole'), q(front, '.lip')]) void run(g, open, ms * 0.18, { easing: 'cubic-bezier(.3,1.4,.5,1)' });
  all('.du').forEach((d, i) => void run(d, [{ transform: 'translate(0,0) scale(.3)', opacity: 0 }, { transform: `translate(0,${-6 * k}px) scale(1)`, opacity: 0.85, offset: 0.25 }, { transform: `translate(${((i % 2 ? 1 : -1) * (6 + i * 2)) * k}px,${-26 * k}px) scale(1.7)`, opacity: 0 }], ms * 0.6, { delay: i * 18 }));
  all('.ch').forEach((c, i) => {
    const a = (i / chips.length) * Math.PI * 2 + i;
    const dx = Math.cos(a) * (28 + (i % 4) * 8) * k;
    return void run(c, [{ transform: 'translate(0,0) rotate(0)', opacity: 1 }, { transform: `translate(${dx * 0.6}px,${-30 * k}px) rotate(200deg)`, opacity: 1, offset: 0.45 }, { transform: `translate(${dx}px,${-4 * k}px) rotate(420deg)`, opacity: 0 }], ms * 0.42, { easing: 'cubic-bezier(.3,.6,.6,1)' });
  });
  await wait(ms * 0.14);
  // Each victim tips over the edge and sinks behind the near lip, shrinking and darkening as it goes down.
  const unclip: (() => void)[] = [];
  await Promise.all(
    victims.map(async (v, i) => {
      if (big && i) await wait(ms * 0.16);
      const pawn = v.art.parentNode as SVGGElement;
      // The clip, in the pawn group's own units: the group is placed at v.at, scaled by v.s, and stays still.
      const L = (bx: number, by: number) => `${((bx - v.at[0]) / v.s).toFixed(1)},${((by - v.at[1]) / v.s).toFixed(1)}`;
      const ro = r * k, rf = r * k * f;
      const cp = document.createElementNS(NS, 'clipPath');
      cp.id = `${id}c${i}`;
      cp.innerHTML = `<path d="M${L(x - 400, y - 400)} L${L(x + 400, y - 400)} L${L(x + 400, y)} L${L(x + ro, y)} A${(ro / v.s).toFixed(1)},${(rf / v.s).toFixed(1)} 0 0 1 ${L(x - ro, y)} L${L(x - 400, y)}Z"/>`;
      layers.under.appendChild(cp);
      pawn.setAttribute('clip-path', `url(#${cp.id})`);
      // The pawn's shadow, glow and rings have no ground to sit on over a hole.
      const rest = [...pawn.children].filter((c) => c !== v.art);
      rest.forEach((c) => void run(c, [{ opacity: 1 }, { opacity: 0 }], ms * 0.08));
      unclip.push(() => {
        pawn.removeAttribute('clip-path');
        rest.forEach((c) => c.getAnimations().forEach((a) => a.cancel()));
        cp.remove();
      });
      // Over the pit's centre (a pair's pawns keep a little of their spread), then down by about a pawn and a half.
      const [dx, dy] = local(v, (x - v.at[0]) * (big ? 0.7 : 1), y - v.at[1] - 4 * k);
      const tip = (v.at[0] <= x ? 1 : -1) * 22;
      const down = (30 * k) / v.s;
      await run(
        v.art,
        [
          { transform: 'none', filter: 'brightness(1)' },
          { transform: `translate(${dx * 0.55}px,${dy * 0.55 - 6}px) rotate(${tip}deg)`, filter: 'brightness(1)', offset: 0.28 },
          { transform: `translate(${dx}px,${dy}px) rotate(${tip * 0.6}deg) scale(.92)`, filter: 'brightness(.85)', offset: 0.42 },
          { transform: `translate(${dx}px,${dy + down}px) rotate(${tip * 0.2}deg) scale(.25)`, filter: 'brightness(.3)' },
        ],
        ms * 0.46,
        { easing: 'cubic-bezier(.45,0,.75,.5)' },
      );
      v.art.style.opacity = '0';
    }),
  );
  await wait(ms * 0.06);
  unclip.forEach((u) => u());
  // The ground closes and the cracks fade.
  const close: Keyframe[] = [{ transform: `scale(${k})`, opacity: 1 }, { transform: 'scale(0)', opacity: 0.6 }];
  for (const g of [q(ground, '.hole'), q(front, '.lip')]) void run(g, close, ms * 0.16, { easing: 'cubic-bezier(.6,0,.9,.5)' });
  await run(q(ground, '.cks'), [{ opacity: 1 }, { opacity: 0 }], ms * 0.2);
  ground.remove();
  front.remove();
  // The attacker hops back onto its square.
  await Promise.all(
    hunters.map((h, i) => {
      const [dx, dy] = aside(h, i);
      return run(h.art, [{ transform: `translate(${dx}px,${dy}px)` }, { transform: `translate(${dx * 0.5}px,${dy * 0.5 - 16}px)`, offset: 0.5 }, { transform: 'none' }], Math.min(300, ms * 0.14), { easing: 'cubic-bezier(.3,.7,.4,1)' });
    }),
  );
  for (const h of hunters) {
    h.art.getAnimations().forEach((a) => a.cancel());
    restOf(h).forEach((c) => c.getAnimations().forEach((a) => a.cancel()));
  }
}

/**
 * Red: a guillotine blade drops onto the victim and cuts it clean in two; the halves fall apart. With
 * `each` (a pair), the blade falls once per pawn: it cuts one, rises, and falls again on the other.
 */
async function guillotine(layer: SVGGElement, at: Pt, ms: number, victims: Victim[], each: boolean) {
  const [x, y] = at;
  const g = el(layer, `<g transform="translate(${x} ${y}) scale(3.4)">
    <g class="bl"><rect x="-26" y="-118" width="5" height="96" fill="#6b4422"/><rect x="21" y="-118" width="5" height="96" fill="#6b4422"/><rect x="-28" y="-122" width="56" height="7" rx="2" fill="#4a2e16"/>
    <g class="blade"><path d="M-21,-60 H21 V-40 L-21,-28Z" fill="#cfd6e0" stroke="#3a4252" stroke-width="1.6"/><path d="M-21,-31 L21,-43" stroke="#fff" stroke-width="1.6"/><rect x="-6" y="-66" width="12" height="7" fill="#3a4252"/></g></g>
    <path class="slash" d="M-30,4 L30,-12" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity="0"/></g>`);
  const q = (sel: string) => g.querySelector(sel)!;
  // Cut in two: two clipped copies of the pawn fall apart while the whole pawn hides.
  const cut = (vs: Victim[]) =>
    vs.flatMap((v, i) => {
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
  // The frame drops in, then the blade falls along it: once, or once per pawn.
  await run(q('.bl'), [{ transform: 'translateY(-50px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], ms * 0.25);
  const rounds = each ? victims.map((v) => [v]) : [victims];
  const parts: Element[] = [];
  for (const [r, vs] of rounds.entries()) {
    if (r > 0) await run(q('.blade'), [{ transform: 'translateY(40px)' }, { transform: 'translateY(0)' }], ms * 0.12, { easing: 'cubic-bezier(.2,.8,.4,1)' });
    await run(q('.blade'), [{ transform: 'translateY(0)' }, { transform: 'translateY(40px)' }], ms * 0.14, { easing: 'cubic-bezier(.8,0,1,.6)' });
    sfx.bust();
    sfx.kill(2);
    shake(layer, r > 0 ? 13 : 10, 380);
    void run(q('.slash'), [{ opacity: 1, transform: 'scaleX(.2)' }, { opacity: 0, transform: 'scaleX(1.4)' }], ms * 0.3);
    parts.push(...cut(vs));
    if (r < rounds.length - 1) await wait(ms * 0.18);
  }
  void run(q('.bl'), [{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0, transform: 'translateY(-30px)' }], ms * 0.6);
  await wait(ms * 0.62);
  parts.forEach((x) => x.remove());
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

/**
 * Yellow: the sky goes dark, three forked bolts strike, and the victim burns to a pile of ash. `big` (a
 * pair): one huge bolt, bigger and brighter, forking onto each pawn, a bigger flash and a harder shake.
 */
async function lightning({ under, top: layer }: Layers, at: Pt, ms: number, victims: Victim[], big: boolean) {
  const [x, y] = at;
  const bolt = (dx: number, rot: number, w: number) => `<g transform="translate(${dx} 0) rotate(${rot})"><path class="bolt" d="M-10,-200 L12,-130 -8,-122 16,-56 -6,-50 6,0 M12,-130 L34,-100 26,-96 44,-70 M16,-56 L-14,-30" fill="none" stroke="#fffbd0" stroke-width="${w + 6}" stroke-linejoin="round" stroke-linecap="round" opacity="0"/><path class="bolt" d="M-10,-200 L12,-130 -8,-122 16,-56 -6,-50 6,0 M12,-130 L34,-100 26,-96 44,-70 M16,-56 L-14,-30" fill="none" stroke="#ffd23f" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round" opacity="0"/></g>`;
  const embers = Array.from({ length: 12 }, (_, i) => `<circle class="em" cx="${(i % 6) * 6 - 15}" cy="0" r="${1.4 + (i % 3) * 0.6}" fill="${i % 2 ? '#ff9a1f' : '#ffd23f'}" opacity="0"/>`).join('');
  // The dark sky falls on the board, under the pieces, so the pawns stay lit by the bolts.
  const sky = el(under, '<rect width="600" height="600" fill="#0a0820"/>');
  // A pair: forks aimed at each pawn (their offsets from the hit, in this group's units) and a thicker trunk.
  const sc = big ? 2.7 : 2;
  const forks = big ? victims.map((v) => bolt((v.at[0] - x) / sc, v.at[0] > x ? 9 : -9, 4)).join('') : `${bolt(-26, -8, 3)}${bolt(24, 10, 3)}`;
  const g = el(layer, `<g transform="translate(${x} ${y}) scale(${sc})"><circle class="glow" r="${big ? 62 : 46}" fill="#fff6b0" opacity="0"/>${forks}${bolt(0, 0, big ? 8 : 5)}
    <g class="ash" opacity="0"><ellipse cx="0" cy="9" rx="13" ry="4.5" fill="#2a241e"/><ellipse cx="-2" cy="6" rx="8" ry="3.6" fill="#4a4038"/><ellipse cx="2" cy="4" rx="4" ry="2.2" fill="#6a6058"/></g>
    <g class="smoke" opacity="0"><circle cx="-4" cy="-6" r="7" fill="#6a6a72"/><circle cx="5" cy="-14" r="9" fill="#55555e"/><circle cx="-2" cy="-26" r="11" fill="#45454d"/></g>${embers}</g>`);
  const q = (s: string) => g.querySelector(s)!;
  void run(sky, [{ opacity: 0 }, { opacity: big ? 0.85 : 0.75, offset: 0.2 }, { opacity: big ? 0.85 : 0.75, offset: 0.7 }, { opacity: 0 }], ms, { easing: 'linear' }).then(() => sky.remove());
  await wait(ms * 0.18);
  sfx.flare();
  sfx.bust();
  if (big) sfx.kill(2);
  shake(layer, big ? 14 : 8, big ? 520 : 380);
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
 * Plays the attacker colour's finisher at the victim's square and takes the victims out. With two victims (a
 * pair captured a pair) and a "full" finisher (`ms` of a second or more), the effect happens for each pawn.
 * Under "full" the earthquake and the doubles take the time to read clearly (the owner: 2.5-3 s is fine,
 * #147), never over 2.9 s; "short" stays quick and plays one effect. Resolves when it's done; the board then
 * puts the victims back in their bases.
 */
export async function playFinisher(layers: Layers, attacker: Color, at: Pt, ms = 560, victims: Victim[] = [], tilted = true, hunters: Piece[] = []): Promise<void> {
  const layer = layers.top;
  const full = ms >= 1000;
  const double = victims.length > 1 && full;
  // Each colour's own length (its effect's ms, and how long it runs in all, for the camera and spotlight).
  const len = (x: number) => Math.min(2900, x);
  const fxMs =
    attacker === 'green' ? len(ms * (double ? 1.9 : full ? 1.4 : 1))
    : attacker === 'red' ? ms * (double ? 1.3 : 1)
    : attacker === 'blue' ? ms * (double ? 1.15 : 1)
    : len(ms * (double ? 1.85 : 1));
  const total = len(
    attacker === 'red' && double ? fxMs * 1.45
    : attacker === 'blue' && double ? ms * 0.55 + fxMs * 1.01
    : fxMs,
  );
  // A spotlight: the board darkens around the hit for the length of the finisher. It sits under the pieces,
  // so every pawn stays bright, and it stays light enough that the board still reads (#147).
  const id = `spot${++spots}`;
  const dim = el(layers.under, `<defs><radialGradient id="${id}" cx="${at[0]}" cy="${at[1]}" r="230" gradientUnits="userSpaceOnUse"><stop offset=".12" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></radialGradient></defs><rect width="600" height="600" fill="url(#${id})"/>`);
  void run(dim, [{ opacity: 0 }, { opacity: 1, offset: (0.15 * ms) / total }, { opacity: 1, offset: 1 - (0.2 * ms) / total }, { opacity: 0 }], total + 160, { easing: 'linear' });
  // The camera: zooms in on the hit, holds through the finisher (a double's too), then pulls back out.
  const frame = layer.ownerSVGElement?.closest<HTMLElement>('.bframe');
  const svg = layer.ownerSVGElement;
  if (frame && svg) {
    const k = svg.clientWidth / 600;
    const dx = (at[0] - 300) * k, dy = (at[1] - 300) * k;
    const span = total + 420;
    const ease = Math.min(0.3, (0.22 * (ms + 420)) / span);
    frame.animate(
      [
        { translate: '0 0', scale: '1' },
        { translate: `${-dx * 0.55}px ${-dy * 0.55}px`, scale: '1.55', offset: ease },
        { translate: `${-dx * 0.55}px ${-dy * 0.55}px`, scale: '1.62', offset: 1 - ease },
        { translate: '0 0', scale: '1' },
      ],
      { duration: span, easing: 'cubic-bezier(.3,.7,.3,1)' },
    );
  }
  const fx =
    attacker === 'green' ? earthquake(layers, at, fxMs, victims, double, tilted, hunters)
    : attacker === 'red' ? guillotine(layer, at, fxMs, victims, double)
    : attacker === 'blue'
      ? double
        ? // Two waves, one after the other, each carrying one pawn away toward its base.
          Promise.all(victims.map((v, i) => wait(i * ms * 0.55).then(() => wave(layer, v.at, fxMs, [v])))).then(() => undefined)
        : wave(layer, at, fxMs, victims)
      : lightning(layers, at, fxMs, victims, double);
  await fx;
  // The victims stay hidden until the board puts them back in their bases.
  for (const v of victims) {
    v.art.getAnimations().forEach((a) => a.cancel());
    v.art.style.opacity = '0';
  }
  await wait(200);
  setTimeout(() => dim.remove(), 180);
}
