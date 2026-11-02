// What the human can tap after a roll: one target per legal move, with where it lands. Pure, no DOM.
import { BASE, FINISHED, HOME_FIRST, countAt, isBlockedFor, isSafe, sameSide, squareOf, type Color, type Move, type PlayerState } from '../engine';
import { spot, type Pt } from './geometry';

export type TargetTag = 'kill' | 'finish' | 'home' | 'safe' | 'plain';

export interface Target {
  move: Move;
  /** Pawn keys ("blue2") whose tap can choose this move. */
  pawns: string[];
  /** Where the move lands, in board units. */
  dest: Pt;
  /** Short label on the landing marker: "+4", "Pair +2" (both tokens move 2), "Out". */
  label: string;
  tag: TargetTag;
}

const SPREAD = 16;

export function moveTargets(players: PlayerState[], moves: Move[]): Target[] {
  // The engine offers one release per base pawn; they all land on the start square, so show one.
  const firstRelease = moves.find((m) => m.kind === 'release');
  const targets = moves.filter((m) => m.kind !== 'release' || m === firstRelease).map((m): Target => {
    const tokens = players.find((p) => p.color === m.color)!.tokens;
    // A release can use any base pawn; other moves any pawn standing on the starting square.
    const pawns = tokens.flatMap((t, i) => ((m.kind === 'release' ? t === BASE : t === m.from) ? [m.color + i] : []));
    const sq = squareOf(m.color, m.to);
    const tag: TargetTag = m.captures.length ? 'kill' : m.to === FINISHED ? 'finish' : m.to >= HOME_FIRST ? 'home' : sq !== null && isSafe(sq) ? 'safe' : 'plain';
    // When a pair could also split, say which marker is which.
    const both = moves.some((x) => x.kind !== m.kind && x.kind !== 'release' && m.kind !== 'release' && x.from === m.from);
    const label = m.kind === 'release' ? 'Out' : m.kind === 'pair' ? `Pair +${m.steps}` : `${both ? 'One ' : ''}+${m.steps}`;
    return { move: m, pawns, dest: spot(m.color, m.to, m.tokens[0]!).pt, label, tag };
  });
  // Targets landing on the same spot are spread sideways so each stays tappable.
  const byDest = new Map<string, Target[]>();
  for (const t of targets) byDest.set(t.dest.join(','), [...(byDest.get(t.dest.join(',')) ?? []), t]);
  for (const group of byDest.values()) {
    group.forEach((t, j) => {
      t.dest = [t.dest[0] + (j - (group.length - 1) / 2) * 2 * SPREAD, t.dest[1]];
    });
  }
  return targets;
}

/** Landing markers closer than this (board units; a square is 40) crowd each other. */
export const CROWD = 80;
/** A marker this close to the pawn of another move sits on it: a tap there is ambiguous. */
export const ON_PAWN = 36;

/**
 * The targets whose markers crowd another move's: landing within CROWD of its marker, or within ON_PAWN
 * of the pawn it moves (an "Out" marker on a pawn that can also move). In move order. These get big
 * numbered buttons below the board, so a choice is never hidden under a pawn or another marker. Empty
 * unless 2-4 targets crowd: one is no choice, and more than four don't fit as buttons (rare).
 */
export function crowded(targets: Target[], players: PlayerState[]): Target[] {
  const d = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const from = (t: Target): Pt => {
    const tokens = players.find((p) => p.color === t.move.color)!.tokens;
    const i = Number(t.pawns[0]!.slice(t.move.color.length));
    return spot(t.move.color, tokens[i]!, i).pt;
  };
  const clash = (t: Target, u: Target) => d(t.dest, u.dest) < CROWD || d(t.dest, from(u)) < ON_PAWN || d(u.dest, from(t)) < ON_PAWN;
  const c = targets.filter((t) => targets.some((u) => u !== t && clash(t, u)));
  return c.length >= 2 && c.length <= 4 ? c : [];
}

const TAG_WORD: Record<TargetTag, string> = { kill: 'kill', finish: 'home!', home: 'home column', safe: 'safe', plain: '' };

/** A target's button text: what moves, how far, and what it does ("Pair +1", "One token +2 · kill"). */
export function choiceText(t: Target): { what: string; does: string } {
  const what = t.move.kind === 'release' ? 'Out' : t.label.replace(/^One /, 'One token ');
  return { what, does: TAG_WORD[t.tag] };
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** Why `color`'s token can't move with `roll`, in a few words for the hint bar. `singles`: doubles are off. */
export function whyStuck(players: PlayerState[], color: Color, token: number, roll: number, nameOf: (c: Color) => string = cap, singles = false): string {
  const t = players.find((p) => p.color === color)!.tokens[token]!;
  if (t === FINISHED) return 'Already home';
  if (t === BASE) return 'Needs a 6 to come out';
  const sq = squareOf(color, t);
  if (!singles && sq !== null && !isSafe(sq) && countAt(players, color, sq) % 2 === 0 && roll % 2 === 1) return 'Locked double: needs an even roll';
  if (t + roll > FINISHED) return `Needs exactly ${FINISHED - t} to finish`;
  for (let p = t + 1; p < t + roll; p++) {
    const s = squareOf(color, p);
    if (s === null || !isBlockedFor(players, s, color, singles)) continue;
    const owner = players.find((o) => !sameSide(players, o.color, color) && countAt(players, o.color, s) >= 2)!;
    return `Blocked by ${nameOf(owner.color)}'s double`;
  }
  return "Can't move with this roll";
}

/** The item closest to `at` within `radius`, or null. */
export function nearest<T extends { pt: Pt }>(items: T[], at: Pt, radius: number): T | null {
  let best: T | null = null;
  let bestD = radius;
  for (const it of items) {
    const d = Math.hypot(it.pt[0] - at[0], it.pt[1] - at[1]);
    if (d <= bestD) {
      bestD = d;
      best = it;
    }
  }
  return best;
}

/** The landing markers are drawn at this scale (boardView: `scale(1.22)`), pills and all. */
export const MARK_SCALE = 1.22;
/** A pill's height (unscaled) and the slack around a drawn pill that still counts as a tap on it. */
const PILL_H = 26;
const PILL_SLACK = 3;

/** A marker's label pill: its offset from the marker (unscaled, as drawn), and its box on the board. */
export interface Pill {
  t: Target;
  text: string;
  /** Width (unscaled), and offset from the marker's centre (unscaled, inside the marker's scale). */
  w: number;
  lx: number;
  ly: number;
  /** Its box in board units: centre and half sizes, the marker's scale applied. */
  cx: number;
  cy: number;
  hw: number;
  hh: number;
}

/**
 * Where each shown marker's label pill goes (#112: the board draws from this, and taps are tested against it,
 * so the two never disagree). Above the marker, else below, else nudged sideways, so neighbouring labels
 * never cover each other; always inside the board. A numbered marker has its words on its button instead,
 * so it gets no pill.
 */
export function labelLayout(shown: Target[], numbered: Target[] = []): Pill[] {
  const taken: { x: number; y: number; w: number }[] = [];
  const out: Pill[] = [];
  for (const t of shown) {
    if (numbered.includes(t)) continue;
    const [x, y] = t.dest;
    const w = t.label.length * 9.6 + (t.tag === 'kill' ? 50 : 20);
    const text = t.tag === 'kill' ? `${t.label} KILL` : t.label;
    const clampX = (cx: number) => Math.min(Math.max(cx, w / 2 + 4), 596 - w / 2);
    const free = (cx: number, cy: number) => taken.every((r) => Math.abs(r.x - cx) > (r.w + w) / 2 + 2 || Math.abs(r.y - cy) > 28);
    const tries: [number, number][] = [];
    for (const dy of y < 60 ? [36, -36] : [-36, 36]) for (const dx of [0, w * 0.6, -w * 0.6]) tries.push([dx, dy]);
    const [dx, dy] = tries.find(([dx, dy]) => free(clampX(x + dx), y + dy)) ?? tries[0]!;
    const px = clampX(x + dx);
    taken.push({ x: px, y: y + dy, w });
    const lx = px - x;
    out.push({ t, text, w, lx, ly: dy, cx: x + MARK_SCALE * lx, cy: y + MARK_SCALE * dy, hw: (MARK_SCALE * w) / 2, hh: (MARK_SCALE * PILL_H) / 2 });
  }
  return out;
}

/** The pill drawn under `at` (with a little slack), or null: a tap on a label is a tap on its marker (#112). */
export function pillAt(pills: Pill[], at: Pt): Pill | null {
  return pills.find((p) => Math.abs(at[0] - p.cx) <= p.hw + PILL_SLACK && Math.abs(at[1] - p.cy) <= p.hh + PILL_SLACK) ?? null;
}

