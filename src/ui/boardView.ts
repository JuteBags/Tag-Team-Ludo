// Live board: places pawns, stacks shared squares, animates moves and captures.
import { isSafe, type Color, type Move, type PlayerState } from '../engine';
import { boardSVG, pawnArt } from './art';
import { spot, stepPoints, type Pt } from './geometry';

const NS = 'http://www.w3.org/2000/svg';
const HOP_MS = 150;
const BASE_SCALE = 1.18;

/** Offsets and scale for 1-4 pawns sharing a square. */
const STACK: Record<number, { o: Pt[]; s: number }> = {
  1: { o: [[0, 0]], s: 1 },
  2: { o: [[-6, 4], [6, 0]], s: 0.84 },
  3: { o: [[-7, 5], [7, 5], [0, -3]], s: 0.72 },
  4: { o: [[-7, 6], [7, 6], [-7, -4], [7, -4]], s: 0.66 },
};

interface Place { x: number; y: number; s: number }

const tween = (ms: number, f: (t: number) => void): Promise<void> => {
  if (document.hidden || ms <= 0) {
    f(1);
    return Promise.resolve();
  }
  return new Promise((done) => {
    const t0 = performance.now();
    let over = false;
    const end = () => {
      if (over) return;
      over = true;
      f(1);
      done();
    };
    const tick = (now: number) => {
      if (over) return;
      const t = (now - t0) / ms;
      if (t >= 1) return end();
      f(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // Some WebViews stop firing rAF while still "visible"; never let a move hang on it.
    setTimeout(end, ms + 60);
  });
};
const ease = (t: number) => 1 - (1 - t) * (1 - t);

export class BoardView {
  readonly el: HTMLElement;
  private pieces: SVGGElement;
  private deco: SVGGElement;
  private fx: SVGGElement;
  private badges: SVGGElement;
  private pawns = new Map<string, SVGGElement>();
  private placed = new Map<string, Place>();
  private onPick: ((key: string) => void) | null = null;

  constructor(players: PlayerState[], size: number) {
    this.el = document.createElement('div');
    this.el.className = 'bframe';
    this.el.style.width = this.el.style.height = `${size}px`;
    this.el.innerHTML = `<div class="binner">${boardSVG()}</div>`;
    const q = (c: string) => this.el.querySelector<SVGGElement>(`.${c}`)!;
    this.pieces = q('pieces');
    this.deco = q('deco');
    this.fx = q('fx');
    this.badges = q('badges');
    for (const p of players) {
      p.tokens.forEach((_, i) => {
        const key = p.color + i;
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('class', 'pawn');
        g.innerHTML = pawnArt(p.color);
        g.addEventListener('click', () => {
          if (g.classList.contains('movable')) this.onPick?.(key);
        });
        this.pieces.appendChild(g);
        this.pawns.set(key, g);
      });
    }
    this.layout(players);
  }

  /** Snaps every pawn to its resting place and redraws pair markers. */
  layout(players: PlayerState[]) {
    const groups = new Map<string, { key: string; color: Color; pt: Pt }[]>();
    for (const p of players) {
      p.tokens.forEach((t, i) => {
        const s = spot(p.color, t, i);
        const list = groups.get(s.key) ?? [];
        list.push({ key: p.color + i, color: p.color, pt: s.pt });
        groups.set(s.key, list);
      });
    }
    let deco = '';
    let badges = '';
    for (const [gk, list] of groups) {
      const inBase = gk.startsWith('base');
      const stack = STACK[Math.min(list.length, 4)]!;
      list.forEach((it, j) => {
        const [ox, oy] = inBase ? [0, 0] : stack.o[Math.min(j, 3)]!;
        this.set(it.key, { x: it.pt[0] + ox, y: it.pt[1] + oy + 3, s: inBase ? BASE_SCALE : stack.s });
      });
      if (!gk.startsWith('t') || list.length < 2) continue;
      const block = !isSafe(Number(gk.slice(1)));
      const counts = new Map<Color, number>();
      for (const it of list) counts.set(it.color, (counts.get(it.color) ?? 0) + 1);
      const [x, y] = list[0]!.pt;
      for (const [, n] of counts) {
        if (n < 2) continue;
        if (block) deco += `<ellipse cx="${x}" cy="${y + 15}" rx="19" ry="6.5" fill="#ffd23f" opacity=".6"/><ellipse cx="${x}" cy="${y + 15}" rx="19" ry="6.5" fill="none" stroke="#fff3b0" stroke-width="1.5"/>`;
        badges += `<g transform="translate(${Math.min(x + 14, 589)} ${Math.max(y - 17, 11)})"><circle r="8.5" fill="${block ? '#ffd23f' : '#fff'}" stroke="#7a4200" stroke-width="1.6"/><text y="3.4" text-anchor="middle" font-family="Lilita One, sans-serif" font-size="10" fill="#5a2d00">×${n}</text></g>`;
      }
    }
    this.deco.innerHTML = deco;
    this.badges.innerHTML = badges;
    this.sortZ();
  }

  /** Highlights tappable pawns; `onPick` gets the pawn key ("blue2"). */
  setMovable(keys: string[], onPick: (key: string) => void) {
    this.clearMovable();
    this.onPick = onPick;
    let fx = '';
    for (const k of keys) {
      this.pawns.get(k)!.classList.add('movable');
      const p = this.placed.get(k)!;
      fx += `<circle class="glow" cx="${p.x}" cy="${p.y - 2}" r="${22 * p.s}"/><circle class="pulse" cx="${p.x}" cy="${p.y - 2}" r="${22 * p.s}"/>`;
    }
    this.fx.innerHTML = fx;
  }

  clearMovable() {
    this.onPick = null;
    this.fx.innerHTML = '';
    for (const g of this.pawns.values()) g.classList.remove('movable');
  }

  /** Hops the moving pawns square by square, sends captured pawns home, then re-lays the board. */
  async animateMove(m: Move, after: PlayerState[], speed = 1) {
    this.clearMovable();
    this.deco.innerHTML = '';
    this.badges.innerHTML = '';
    const keys = m.tokens.map((i) => m.color + i);
    for (const k of keys) this.pieces.appendChild(this.pawns.get(k)!);
    const offs: Pt[] = keys.length === 2 ? [[-6, 4], [6, 0]] : [[0, 0]];
    const s = keys.length === 2 ? 0.84 : 1;
    let from = keys.map((k) => this.placed.get(k)!);
    const pts = stepPoints(m.color, m.from, m.to);
    for (const pt of pts) {
      const to = offs.map(([ox, oy]) => ({ x: pt[0] + ox, y: pt[1] + oy + 3, s }));
      await this.hop(keys, from, to, (m.from < 0 ? 2 : 1) * HOP_MS / speed, 14);
      from = to;
    }
    if (m.captures.length) {
      const [x, y] = pts[pts.length - 1]!;
      this.burst(x, y);
      await Promise.all(
        m.captures.map((c) => {
          const k = c.color + c.token;
          const { pt } = spot(c.color, -1, c.token);
          this.pieces.appendChild(this.pawns.get(k)!);
          return this.hop([k], [this.placed.get(k)!], [{ x: pt[0], y: pt[1] + 3, s: BASE_SCALE }], 520 / speed, 70);
        }),
      );
    }
    this.layout(after);
  }

  private hop(keys: string[], from: Place[], to: Place[], ms: number, height: number) {
    return tween(ms, (t) => {
      const e = ease(t);
      keys.forEach((k, j) => {
        const a = from[j]!, b = to[j]!;
        this.set(k, { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e - height * Math.sin(Math.PI * t), s: a.s + (b.s - a.s) * e });
      });
    });
  }

  private burst(x: number, y: number) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('class', 'burst');
    c.setAttribute('cx', String(x));
    c.setAttribute('cy', String(y));
    c.setAttribute('r', '18');
    this.badges.appendChild(c);
    setTimeout(() => c.remove(), 600);
  }

  private set(key: string, p: Place) {
    this.placed.set(key, p);
    this.pawns.get(key)!.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) scale(${p.s.toFixed(3)})`);
  }

  /** Lower pawns are drawn last so they overlap the ones behind them. */
  private sortZ() {
    [...this.pawns.entries()]
      .sort((a, b) => this.placed.get(a[0])!.y - this.placed.get(b[0])!.y)
      .forEach(([, g]) => this.pieces.appendChild(g));
  }
}
