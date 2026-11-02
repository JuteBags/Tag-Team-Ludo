// Live board: places pawns, stacks shared squares, shows where moves land, animates moves and captures.
import { isSafe, type Color, type Move, type PlayerState } from '../engine';
import { PALETTE, boardSVG, pawnArt } from './art';
import { playFinisher } from './finishers';
import { spot, stepPoints, type Pt } from './geometry';
import { sfx } from './sfx';
import { nearest, type Target } from './targets';

const NS = 'http://www.w3.org/2000/svg';
const HOP_MS = 150;
const BASE_SCALE = 1.75;
/** A lone pawn on the track: taller than its square, so it reads as a piece standing on the board. */
const TRACK_SCALE = 1.62;
/** The game board's tilt toward the player (CSS, see .tilted in styles.css) and its perspective. */
const TILT = (18 * Math.PI) / 180;
const PERSPECTIVE = 1100;
/** Tap radius in board units (the board is 600 wide): about 20px on a phone, well over a 40px target. */
const HIT = 34;
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Offsets and scale for 1-4 pawns sharing a square. */
const STACK: Record<number, { o: Pt[]; s: number }> = {
  1: { o: [[0, 0]], s: TRACK_SCALE },
  2: { o: [[-7, 2], [7, -1]], s: 1.3 },
  3: { o: [[-9, 4], [9, 4], [0, -5]], s: 1.0 },
  4: { o: [[-9, 5], [9, 5], [-9, -6], [9, -6]], s: 0.9 },
};

/** Position, scale, squash (+ wide/short, - tall/thin) and spin of a pawn. */
interface Place { x: number; y: number; s: number; q?: number; r?: number }

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

/**
 * Where a marker's label goes, relative to the marker: above, else below, else nudged sideways,
 * so neighbouring labels never cover each other; always inside the board. Records the spot in `taken`.
 */
function placeLabel(x: number, y: number, w: number, taken: { x: number; y: number; w: number }[]) {
  const clampX = (cx: number) => Math.min(Math.max(cx, w / 2 + 4), 596 - w / 2);
  const free = (cx: number, cy: number) => taken.every((r) => Math.abs(r.x - cx) > (r.w + w) / 2 + 2 || Math.abs(r.y - cy) > 28);
  const tries: [number, number][] = [];
  for (const dy of y < 60 ? [36, -36] : [-36, 36]) for (const dx of [0, w * 0.6, -w * 0.6]) tries.push([dx, dy]);
  const [dx, dy] = tries.find(([dx, dy]) => free(clampX(x + dx), y + dy)) ?? tries[0]!;
  const cx = clampX(x + dx);
  taken.push({ x: cx, y: y + dy, w });
  return { lx: cx - x, ly: dy };
}
const TAG_COLOR = { kill: '#ff3b3b', finish: '#ffc21a', home: '#ffffff', safe: '#ffd23f' } as const;

export class BoardView {
  readonly el: HTMLElement;
  private svg: SVGSVGElement;
  private pieces: SVGGElement;
  private deco: SVGGElement;
  private fx: SVGGElement;
  private marks: SVGGElement;
  private badges: SVGGElement;
  private pawns = new Map<string, SVGGElement>();
  private placed = new Map<string, Place>();
  private targets: Target[] = [];
  /** Targets with a numbered button below the board (crowded ones): their marker shows the number. */
  private numbered: Target[] = [];
  private onChoose: ((t: Target) => void) | null = null;
  private onSelect: ((ts: Target[]) => void) | null = null;
  private onStuck: ((pawn: string) => void) | null = null;
  /** Pawn whose several moves are on show (a pair on a star: move both, or one). */
  private selected: string | null = null;
  private focusKey = '';
  /** Markers pop in only when they first appear, not on every hover redraw. */
  private fresh = false;

  /**
   * The one-time "you can be cut here" tip: 'unseen', the pawn key it is showing on, or 'done'.
   * Stored, so it is shown once per install.
   */
  private riskTip: string;

  /**
   * `singles`: doubles are off, so stacked tokens are just a stack (no lock, no "cut here" tip).
   * `tilted`: the board leans back in perspective (the game board; the home screen has its own tilt).
   */
  constructor(players: PlayerState[], size: number, private humans: Color[] = [], private singles = false, private tilted = false) {
    let seen = false;
    try {
      seen = localStorage.getItem('ludo-tip-risk') === '1';
    } catch {
      // Storage blocked: the tip may show again next launch.
    }
    this.riskTip = seen ? 'done' : 'unseen';
    this.el = document.createElement('div');
    this.el.className = tilted ? 'bframe tilted' : 'bframe';
    this.el.style.width = this.el.style.height = `${size}px`;
    this.el.innerHTML = `<div class="binner">${boardSVG()}</div>`;
    const q = (c: string) => this.el.querySelector<SVGGElement>(`.${c}`)!;
    this.svg = this.el.querySelector('svg')!;
    this.pieces = q('pieces');
    this.deco = q('deco');
    this.fx = q('fx');
    this.marks = q('marks');
    this.badges = q('badges');
    for (const p of players) {
      p.tokens.forEach((_, i) => {
        const g = document.createElementNS(NS, 'g');
        // Your own pawns wear the white halo, so they're easy to tell apart from everyone else's.
        g.setAttribute('class', humans.includes(p.color) ? 'pawn mine' : 'pawn');
        g.innerHTML = pawnArt(p.color);
        this.pieces.appendChild(g);
        this.pawns.set(p.color + i, g);
      });
    }
    // One handler for the whole board: a tap goes to the nearest pawn or landing spot, so small
    // pieces are easy to hit with a finger.
    this.svg.addEventListener('click', (e) => this.tap(this.toBoard(e)));
    this.svg.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' || !this.onChoose) return;
      const hit = this.hit(this.toBoard(e));
      this.svg.style.cursor = hit ? 'pointer' : '';
      this.drawTargets(hit ? ('target' in hit ? [hit.target] : this.targetsOf(hit.pawn)) : undefined);
    });
    this.layout(players);
  }

  /** Rings the pawns that just moved (the replay's "this one moved"); none clears it. Keys are colour + index. */
  markMoved(keys: string[]) {
    for (const [k, g] of this.pawns) g.classList.toggle('moved', keys.includes(k));
  }

  /**
   * The review's picture of a decision (the replay in review mode): the move played as a solid trail with its
   * label's symbol at the head, and the best move as a dashed trail to a dashed ghost pawn tagged "Best", so
   * the two differ by shape, not only colour. Null clears it.
   */
  showVerdict(v: { played: Move; best?: Move; sym: string; color: string } | null) {
    if (!v) {
      this.marks.innerHTML = '';
      return;
    }
    const trail = (m: Move) => {
      const t = m.tokens[0]!;
      const pts = [spot(m.color, m.kind === 'release' ? -1 : m.from, t).pt, ...stepPoints(m.color, m.kind === 'release' ? -1 : m.from, m.to)];
      pts[pts.length - 1] = spot(m.color, m.to, t).pt;
      return pts;
    };
    const line = (pts: Pt[]) => pts.map((p) => p.join(',')).join(' ');
    let s = '';
    if (v.best) {
      const pts = trail(v.best);
      const [x, y] = pts.at(-1)!;
      // A white dash over a dark outline reads on every tile (a green dash vanished on the green track).
      s += `<polyline class="vtrail bestbg" points="${line(pts)}"/><polyline class="vtrail best" points="${line(pts)}"/>
        <g class="ghost" transform="translate(${x} ${y})"><circle r="22" class="gpulse"/><circle r="20" class="gring"/><g class="gpawn">${pawnArt(v.best.color)}</g>
        <g transform="translate(0 -40)"><rect x="-32" y="-15" width="64" height="30" rx="15" class="gtag"/><text y="6.5" text-anchor="middle">BEST</text></g></g>`;
    }
    const pts = trail(v.played);
    const [hx, hy] = pts.at(-1)!;
    s += `<polyline class="vtrail played" points="${line(pts)}" style="--c:${v.color}"/>
      <g class="vhead" transform="translate(${hx + 16} ${hy - 16})" style="--c:${v.color}"><circle r="12"/><text y="5" text-anchor="middle">${v.sym}</text></g>`;
    this.marks.innerHTML = s;
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
    let atRisk = false;
    for (const [gk, list] of groups) {
      const inBase = gk.startsWith('base');
      const stack = STACK[Math.min(list.length, 4)]!;
      list.forEach((it, j) => {
        const [ox, oy] = inBase ? [0, 0] : stack.o[Math.min(j, 3)]!;
        this.set(it.key, { x: it.pt[0] + ox, y: it.pt[1] + oy, s: inBase ? BASE_SCALE : stack.s });
      });
      if (!gk.startsWith('t') || list.length < 2) continue;
      const block = !this.singles && !isSafe(Number(gk.slice(1)));
      const counts = new Map<Color, number>();
      for (const it of list) counts.set(it.color, (counts.get(it.color) ?? 0) + 1);
      const [x, y] = list[0]!.pt;
      const bx = Math.min(x + 15, 588), by = Math.max(y - 18, 12);
      let doubled = false;
      for (const [, n] of counts) {
        if (n < 2) continue;
        doubled = true;
        if (block) {
          // A locked double: gold ring and a padlock.
          deco += `<ellipse cx="${x}" cy="${y + 12}" rx="19" ry="6.5" fill="#ffd23f" opacity=".65"/><ellipse cx="${x}" cy="${y + 12}" rx="19" ry="6.5" fill="none" stroke="#fff3b0" stroke-width="1.5"/>`;
          badges += `<g transform="translate(${bx} ${by})"><circle r="10" fill="#ffd23f" stroke="#7a4200" stroke-width="1.8"/><path d="M-3.4,-1 V-3.2 a3.4,3.4 0 0 1 6.8,0 V-1" fill="none" stroke="#5a2d00" stroke-width="1.8"/><rect x="-5" y="-1.5" width="10" height="7.5" rx="1.8" fill="#5a2d00"/></g>`;
        } else {
          // A pair on a star: split, it can move together or one at a time. With doubles off, just a stack.
          badges += `<g transform="translate(${bx} ${by})"><circle r="10" fill="#fff" stroke="#7a4200" stroke-width="1.8"/><text y="4" text-anchor="middle" font-family="Lilita One, sans-serif" font-size="12" fill="#5a2d00">×${n}</text></g>`;
        }
      }
      // A single sitting on an enemy double can be cut there. We tell the human once, on their own
      // token, the first time it ever happens; after that spotting it is part of the game.
      for (const human of block && doubled && this.riskTip !== 'done' ? this.humans : []) {
        const n = counts.get(human) ?? 0;
        if (n % 2 === 1 && [...counts].some(([o, m]) => o !== human && m >= 2)) {
          const key = list.find((it) => it.color === human)!.key;
          if (this.riskTip === 'unseen') this.riskTip = key;
          if (this.riskTip === key) {
            atRisk = true;
            const p = this.placed.get(key)!;
            badges += `<g transform="translate(${Math.max(p.x - 15, 12)} ${Math.max(p.y - 22, 12)})"><circle r="9" fill="#ff3b3b" stroke="#fff" stroke-width="2"/><text y="4.5" text-anchor="middle" font-family="Lilita One, sans-serif" font-size="13" fill="#fff">!</text></g>`;
          }
        }
      }
    }
    // The tip goes away for good once that token is no longer at risk.
    if (!atRisk && this.riskTip !== 'unseen' && this.riskTip !== 'done') {
      this.riskTip = 'done';
      try {
        localStorage.setItem('ludo-tip-risk', '1');
      } catch {
        // Not saved; it may show once more next launch.
      }
    }
    this.deco.innerHTML = deco;
    this.badges.innerHTML = badges;
    this.sortZ();
  }

  // ---------- choosing a move ----------

  /**
   * Shows every move as a marker where it would land. Tapping a marker plays that move; tapping a
   * pawn plays its move, or, when it has several (a pair on a star), shows just those.
   */
  /**
   * `numbered`: targets that also have a numbered button below the board (crowded ones). Their markers
   * show the same number and no label, so a crowded spot stays readable.
   */
  showTargets(targets: Target[], onChoose: (t: Target) => void, onSelect?: (ts: Target[]) => void, onStuck?: (pawn: string) => void, numbered: Target[] = []) {
    this.clearMovable();
    this.svg.classList.toggle('choosing', targets.length > 0);
    this.targets = targets;
    this.numbered = numbered;
    this.onChoose = onChoose;
    this.onSelect = onSelect ?? null;
    this.onStuck = onStuck ?? null;
    for (const t of targets) for (const k of t.pawns) this.pawns.get(k)!.classList.add('movable');
    this.fresh = true;
    this.drawTargets();
  }

  clearMovable() {
    this.targets = [];
    this.numbered = [];
    this.onChoose = this.onSelect = this.onStuck = null;
    this.selected = null;
    this.focusKey = '';
    this.fx.innerHTML = this.marks.innerHTML = '';
    this.svg.style.cursor = '';
    for (const g of this.pawns.values()) g.classList.remove('movable');
    this.svg.classList.remove('choosing');
  }

  private targetsOf(pawn: string) {
    return this.targets.filter((t) => t.pawns.includes(pawn));
  }

  private tap(at: Pt) {
    if (!this.onChoose) return;
    const hit = this.hit(at);
    if (!hit) {
      // One of your own pawns that can't move: say why.
      const color = this.targets[0]?.move.color;
      const own = [...this.pawns.keys()].filter((k) => color && k.startsWith(color) && !this.pawns.get(k)!.classList.contains('movable'));
      const stuck = nearest(own.map((k) => ({ k, pt: [this.placed.get(k)!.x, this.placed.get(k)!.y] as Pt })), at, HIT);
      if (stuck) {
        sfx.tick();
        this.onStuck?.(stuck.k);
      }
      if (this.selected) {
        this.selected = null;
        this.drawTargets();
      }
      return;
    }
    if ('target' in hit) return this.choose(hit.target);
    const own = this.targetsOf(hit.pawn);
    if (own.length === 1) return this.choose(own[0]!);
    this.selected = hit.pawn;
    sfx.tick();
    this.drawTargets(own);
    this.onSelect?.(own);
  }

  /** Plays `t` as if its marker was tapped (a choice button below the board). */
  pick(t: Target) {
    if (this.onChoose && this.targets.includes(t)) this.choose(t);
  }

  private choose(t: Target) {
    const f = this.onChoose;
    this.clearMovable();
    f?.(t);
  }

  /** Nearest movable pawn or landing spot. A pawn wins a near-tie: its marker may sit on another pawn. */
  private hit(at: Pt): { pawn: string } | { target: Target } | null {
    const keys = [...new Set((this.selected ? this.targetsOf(this.selected) : this.targets).flatMap((t) => t.pawns))];
    const pawn = nearest(keys.map((k) => ({ k, pt: [this.placed.get(k)!.x, this.placed.get(k)!.y] as Pt })), at, HIT);
    const pool = this.selected ? this.targetsOf(this.selected) : this.targets;
    const dest = nearest(pool.map((t) => ({ t, pt: t.dest })), at, HIT);
    if (pawn && (!dest || Math.hypot(pawn.pt[0] - at[0], pawn.pt[1] - at[1]) <= Math.hypot(dest.pt[0] - at[0], dest.pt[1] - at[1]) + 6)) return { pawn: pawn.k };
    return dest ? { target: dest.t } : null;
  }

  private drawTargets(focus?: Target[]) {
    const shown = this.selected ? this.targetsOf(this.selected) : this.targets;
    const on = focus ?? (this.selected ? shown : []);
    const key = on.map((t) => this.targets.indexOf(t)).join(',') + '|' + this.selected;
    if (key === this.focusKey && this.marks.childElementCount) return;
    this.focusKey = key;
    let s = '';
    for (const k of new Set(shown.flatMap((t) => t.pawns))) {
      const p = this.placed.get(k)!;
      s += `<circle class="glow" cx="${p.x}" cy="${p.y}" r="${21 * p.s}"/><circle class="pulse" cx="${p.x}" cy="${p.y}" r="${21 * p.s}"/>`;
    }
    // Path previews for the focused moves, under the markers.
    for (const t of on) {
      const from = this.placed.get(t.pawns[0]!)!;
      const pts = [[from.x, from.y], ...stepPoints(t.move.color, t.move.from, t.move.to)];
      pts[pts.length - 1] = t.dest;
      s += `<polyline class="trail" points="${pts.map((p) => p.join(',')).join(' ')}"/>`;
    }
    let m = '';
    const taken: { x: number; y: number; w: number }[] = [];
    for (const t of shown) {
      const c = t.tag === 'plain' ? PALETTE[t.move.color].m : TAG_COLOR[t.tag];
      const [x, y] = t.dest;
      const n = this.numbered.indexOf(t) + 1;
      const w = t.label.length * 9.6 + (t.tag === 'kill' ? 50 : 20);
      const text = t.tag === 'kill' ? `${t.label} KILL` : t.label;
      // A numbered marker has its words on its button instead, so no pill piles up on a crowded spot.
      const pill = n ? '' : (() => {
        const { lx, ly } = placeLabel(x, y, w, taken);
        return `<g transform="translate(${lx} ${ly})"><rect x="${-w / 2}" y="-13" width="${w}" height="26" rx="13" class="pill"/><text y="6.5" text-anchor="middle">${text}</text></g>`;
      })();
      const icon =
        n ? `<text class="num" y="6.5" text-anchor="middle">${n}</text>`
        : t.tag === 'kill' ? `<path d="M-6,-6 L6,6 M6,-6 L-6,6" stroke="#fff" stroke-width="3" stroke-linecap="round"/>`
        : t.tag === 'safe' ? `<path d="M0,-7 L2,-2 7,-2 3,1.5 4.5,6.5 0,3.5 -4.5,6.5 -3,1.5 -7,-2 -2,-2Z" fill="#fff"/>`
        : t.tag === 'home' || t.tag === 'finish' ? `<path d="M-6,1 L0,-6 L6,1 M-4,0 V6 H4 V0" fill="none" stroke="#5a2d00" stroke-width="2.2" stroke-linejoin="round"/>`
        : `<circle r="4" fill="#fff"/>`;
      m += `<g class="mark ${t.tag}${on.includes(t) ? ' on' : ''}${this.fresh ? ' fresh' : ''}" transform="translate(${x} ${y}) scale(1.22)" style="--c:${c}">
        <circle class="ring" r="18"/><circle class="core" r="13"/>${icon}${pill}</g>`;
    }
    this.fx.innerHTML = s;
    this.marks.innerHTML = m;
    this.fresh = false;
  }

  private toBoard(e: MouseEvent): Pt {
    if (this.tilted) {
      // The frame is rotated about its centre by TILT around the x axis, seen through PERSPECTIVE px.
      // Its parent is not transformed, so its box (and the stage scale k) give the centre on screen.
      const host = this.el.parentElement!;
      const r = host.getBoundingClientRect();
      const k = r.width / host.offsetWidth;
      const xs = (e.clientX - (r.left + r.width / 2)) / k;
      const ys = (e.clientY - (r.top + r.height / 2)) / k;
      const sin = Math.sin(TILT), cos = Math.cos(TILT);
      const y = (ys * PERSPECTIVE) / (PERSPECTIVE * cos + ys * sin);
      const x = (xs * (PERSPECTIVE - y * sin)) / PERSPECTIVE;
      // From frame px (centre origin) to board units: the SVG fills the frame inside its padding.
      const size = this.el.offsetWidth, pad = (size - this.svg.clientWidth) / 2;
      return [((x + size / 2 - pad) / this.svg.clientWidth) * 600, ((y + size / 2 - pad) / this.svg.clientWidth) * 600];
    }
    const p = this.svg.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    const q = p.matrixTransform(this.svg.getScreenCTM()!.inverse());
    return [q.x, q.y];
  }

  // ---------- animation ----------

  /**
   * Hops the moving pawns square by square, sends captured pawns home, then re-lays the board. `onHit`
   * runs at the moment of a capture's impact, so the KILL banner lands with the blow.
   */
  async animateMove(m: Move, after: PlayerState[], speed = 1, onHit?: () => void, finisherMs = 0) {
    this.clearMovable();
    this.deco.innerHTML = '';
    this.badges.innerHTML = '';
    const keys = m.tokens.map((i) => m.color + i);
    for (const k of keys) this.pieces.appendChild(this.pawns.get(k)!);
    const offs: Pt[] = keys.length === 2 ? STACK[2]!.o : [[0, 0]];
    const s = keys.length === 2 ? STACK[2]!.s : TRACK_SCALE;
    let from = keys.map((k) => this.placed.get(k)!);
    // Where the attacker started: Green's shot is fired from there.
    const origin: Pt = [from[0]!.x, from[0]!.y];
    const pts = stepPoints(m.color, m.from, m.to);
    const kill = m.captures.length > 0;
    for (const [i, pt] of pts.entries()) {
      const last = i === pts.length - 1;
      const to = offs.map(([ox, oy]) => ({ x: pt[0] + ox, y: pt[1] + oy, s }));
      // The killing hop is a big leap that slams down.
      if (document.documentElement.dataset.theme === 'tron' && !calm()) this.lightTrail(from[0]!, to[0]!, PALETTE[m.color].m);
      await this.hop(keys, from, to, ((m.from < 0 ? 2 : 1) * HOP_MS * (last && kill ? 2.2 : 1)) / speed, last && kill ? 46 : 14);
      if (!(last && kill)) sfx.hop();
      void this.squash(keys, last ? 0.22 : 0.1, 140 / speed);
      from = to;
    }
    const [x, y] = pts[pts.length - 1]!;
    if (m.from < 0) {
      sfx.release();
      this.pop(x, y, PALETTE[m.color].l);
    }
    if (kill) {
      // The attacker's colour finishes the kill its own way (finishers.ts) and takes the victim out:
      // swept away, burnt, cut in two or shot back. The victim then reappears in its base.
      const finisher = finisherMs > 0 && !calm();
      if (finisher) {
        const victims = m.captures.map((c) => ({ art: this.pawns.get(c.color + c.token)!.querySelector<SVGGElement>('.pawn-art')!, home: spot(c.color, -1, c.token).pt, s: this.placed.get(c.color + c.token)!.s }));
        await playFinisher(this.badges, m.color, origin, [x, y], finisherMs / speed, victims);
        onHit?.();
      }
      sfx.kill(m.captures.length);
      // Hit-stop: the attacker lands and everything holds for a beat before the victim flies.
      await this.squash(keys, 0.35, 120 / speed);
      this.impact(x, y, PALETTE[m.captures[0]!.color].m, m.captures.length);
      if (!finisher) onHit?.();
      await Promise.all(
        m.captures.map((c, j) => {
          const k = c.color + c.token;
          const { pt } = spot(c.color, -1, c.token);
          this.pieces.appendChild(this.pawns.get(k)!);
          const start = this.placed.get(k)!;
          const home = { x: pt[0], y: pt[1], s: BASE_SCALE };
          if (finisher) {
            // Already taken out by the finisher: it just reappears at home.
            this.set(k, home);
            const art = this.pawns.get(k)!.querySelector('.pawn-art')!;
            art.getAnimations().forEach((a) => a.cancel());
            (art as SVGGElement).style.opacity = '';
            this.pop(pt[0], pt[1], PALETTE[c.color].l);
            return art.animate([{ opacity: 0, transform: 'scale(.3)' }, { opacity: 1, transform: 'scale(1.15)', offset: 0.7 }, { opacity: 1, transform: 'scale(1)' }], { duration: 380 / speed, easing: 'cubic-bezier(.3,.8,.4,1.2)' }).finished;
          }
          return this.launch(k, start, { ...home, r: (j ? -1 : 1) * 900 }, (980 + j * 90) / speed).then(() => {
            this.pop(pt[0], pt[1], PALETTE[c.color].l);
            return this.squash([k], 0.3, 220 / speed);
          });
        }),
      );
    }
    if (m.finishes) {
      sfx.home();
      this.starBurst(x, y);
    }
    this.layout(after);
  }

  private hop(keys: string[], from: Place[], to: Place[], ms: number, height: number) {
    return tween(ms, (t) => {
      const e = ease(t);
      const air = Math.sin(Math.PI * t);
      keys.forEach((k, j) => {
        const a = from[j]!, b = to[j]!;
        const r = (a.r ?? 0) + ((b.r ?? 0) - (a.r ?? 0)) * e;
        // Stretch tall in the air.
        this.set(k, { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e - height * air, s: a.s + (b.s - a.s) * e, q: -0.12 * air, r: t >= 1 ? 0 : r });
      });
    });
  }

  /** Tron: a line of light from one square to the next in the pawn's colour, fading out (a light-cycle trail). */
  private lightTrail(a: Place, b: Place, color: string) {
    const l = document.createElementNS(NS, 'line');
    for (const [k, v] of [['x1', a.x], ['y1', a.y + 8], ['x2', b.x], ['y2', b.y + 8]] as const) l.setAttribute(k, String(v));
    l.setAttribute('class', 'ltrail');
    l.style.stroke = color;
    this.deco.appendChild(l);
    l.animate([{ opacity: 1, strokeWidth: 7 }, { opacity: 0.8, strokeWidth: 5, offset: 0.3 }, { opacity: 0, strokeWidth: 2 }], { duration: 1600, easing: 'ease-out' }).finished.finally(() => l.remove());
  }

  /** A captured pawn thrown home: up high, growing as it nears the camera, spinning, then dropping in. */
  private launch(k: string, a: Place, b: Place, ms: number) {
    return tween(ms, (t) => {
      const e = ease(t);
      const air = Math.sin(Math.PI * t);
      this.set(k, { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e - 240 * air, s: (a.s + (b.s - a.s) * e) * (1 + 0.9 * air), q: -0.1 * air, r: t >= 1 ? 0 : (b.r ?? 0) * e });
    });
  }

  /** A quick landing squash that springs back. */
  private squash(keys: string[], amount: number, ms: number) {
    if (calm()) return Promise.resolve();
    const base = keys.map((k) => this.placed.get(k)!);
    return tween(ms, (t) => {
      const q = amount * Math.sin(Math.PI * t) * (1 - t);
      keys.forEach((k, j) => this.set(k, { ...base[j]!, q }));
    }).then(() => keys.forEach((k, j) => this.set(k, { ...base[j]!, q: 0 })));
  }

  // ---------- effects ----------

  /** The kill: board shake, shockwave rings and sparks in the victim's colour. */
  private impact(x: number, y: number, color: string, n: number) {
    this.ring(x, y, '#fff', 18, 3.2, 520);
    this.ring(x, y, color, 14, 4.2, 680);
    if (calm()) return;
    this.sparks(x, y, [color, '#fff', '#ffd23f'], 14 * n, 70 + 30 * n);
    this.el.animate(
      [{ transform: 'translate(0,0)' }, { transform: 'translate(-11px,6px) rotate(-1deg)' }, { transform: 'translate(10px,-8px) rotate(.9deg)' }, { transform: 'translate(-7px,5px) rotate(-.5deg)' }, { transform: 'translate(4px,-3px)' }, { transform: 'translate(-2px,1px)' }, { transform: 'translate(0,0)' }],
      { duration: 480, easing: 'cubic-bezier(.2,.8,.3,1)' },
    );
    const flash = document.createElementNS(NS, 'rect');
    flash.setAttribute('width', '600');
    flash.setAttribute('height', '600');
    flash.setAttribute('fill', color);
    this.badges.appendChild(flash);
    flash.animate([{ opacity: 0.35 }, { opacity: 0 }], { duration: 260, easing: 'ease-out' }).finished.finally(() => flash.remove());
  }

  /** Gold star burst for a token reaching the centre. */
  private starBurst(x: number, y: number) {
    this.ring(x, y, '#ffd23f', 12, 4, 700);
    if (!calm()) this.sparks(x, y, ['#ffd23f', '#fff6c2', '#ff9f1a'], 18, 90, true);
  }

  /** A pawn arriving somewhere new: a small ring. */
  private pop(x: number, y: number, color: string) {
    this.ring(x, y, color, 10, 2.4, 420);
  }

  private ring(x: number, y: number, color: string, r: number, grow: number, ms: number) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', String(x));
    c.setAttribute('cy', String(y));
    c.setAttribute('r', String(r));
    c.setAttribute('class', 'shock');
    c.style.stroke = color;
    this.badges.appendChild(c);
    c.animate([{ transform: 'scale(.4)', opacity: 1, strokeWidth: 7 }, { transform: `scale(${grow})`, opacity: 0, strokeWidth: 1 }], { duration: ms, easing: 'cubic-bezier(.16,1,.3,1)' }).finished.finally(() => c.remove());
  }

  private sparks(x: number, y: number, colors: string[], n: number, dist: number, stars = false) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const d = dist * (0.55 + Math.random() * 0.6);
      const el = document.createElementNS(NS, stars ? 'path' : 'circle');
      if (stars) el.setAttribute('d', 'M0,-5 L1.4,-1.4 5,0 1.4,1.4 0,5 -1.4,1.4 -5,0 -1.4,-1.4Z');
      else el.setAttribute('r', String(2.2 + Math.random() * 2.6));
      el.setAttribute('fill', colors[i % colors.length]!);
      // The group places the spark; the animation moves it relative to that.
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('transform', `translate(${x} ${y})`);
      g.appendChild(el);
      this.badges.appendChild(g);
      el.animate(
        [{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: `translate(${Math.cos(a) * d}px,${Math.sin(a) * d + 18}px) scale(.2) rotate(${stars ? 180 : 0}deg)`, opacity: 0 }],
        { duration: 600 + Math.random() * 300, easing: 'cubic-bezier(.16,1,.3,1)' },
      ).finished.finally(() => g.remove());
    }
  }

  private set(key: string, p: Place) {
    this.placed.set(key, p);
    const q = p.q ?? 0;
    this.pawns.get(key)!.setAttribute(
      'transform',
      `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${(p.r ?? 0).toFixed(0)}) scale(${(p.s * (1 + q)).toFixed(3)} ${(p.s * (1 - q)).toFixed(3)})`,
    );
  }

  /** Lower pawns are drawn last so they overlap the ones behind them. */
  private sortZ() {
    [...this.pawns.entries()]
      .sort((a, b) => this.placed.get(a[0])!.y - this.placed.get(b[0])!.y)
      .forEach(([, g]) => this.pieces.appendChild(g));
  }
}
