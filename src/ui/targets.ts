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
  /** Short label on the landing marker: "+4", "+2 +2", "Out". */
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
    const label = m.kind === 'release' ? 'Out' : m.kind === 'pair' ? `${both ? 'Pair ' : ''}+${m.steps} +${m.steps}` : `${both ? 'One ' : ''}+${m.steps}`;
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

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** Why `color`'s token can't move with `roll`, in a few words for the hint bar. */
export function whyStuck(players: PlayerState[], color: Color, token: number, roll: number, nameOf: (c: Color) => string = cap): string {
  const t = players.find((p) => p.color === color)!.tokens[token]!;
  if (t === FINISHED) return 'Already home';
  if (t === BASE) return 'Needs a 6 to come out';
  const sq = squareOf(color, t);
  if (sq !== null && !isSafe(sq) && countAt(players, color, sq) % 2 === 0 && roll % 2 === 1) return 'Locked double: needs an even roll';
  if (t + roll > FINISHED) return `Needs exactly ${FINISHED - t} to finish`;
  for (let p = t + 1; p < t + roll; p++) {
    const s = squareOf(color, p);
    if (s === null || !isBlockedFor(players, s, color)) continue;
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
