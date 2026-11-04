// Undo (#143): take back your last move after a mis-touch, 1 or 2 times a game. Fair by one rule: it is only
// offered until new dice appear (anyone's roll, your own extra roll included), so it never lets you see
// something and then change your mind. The dice are seeded by position (gameScreen rngFor), so playing the same
// move again gives exactly the same dice. The game screen keeps one frame per person's move this turn; this
// file is the bookkeeping, pure so it is tested.
import { FINISHED, type GameState } from '../engine';

/** What a move changes on the game screen, as it was just before the move. */
export interface UndoFrame<C = unknown> {
  owner: number;
  state: GameState;
  /** The record's length before the move (the log is cut back to it, so the record keeps the moves that stood). */
  logLen: number | null;
  /** The screen's own counters (kills, pairs, tokens lost...), restored with the state. */
  counters: C;
  /** A move the person chose (a mis-touch can happen); one with nothing to choose isn't undone on its own. */
  picked: boolean;
}

/** Undos per game, the setting's choices. */
export const UNDO_CHOICES = [0, 1, 2] as const;
/** How long the turn-ends window stays open, in ms. */
export const UNDO_WINDOW_MS = 2500;

export class UndoBook<C = unknown> {
  private frames: UndoFrame<C>[] = [];
  private used = new Map<number, number>();

  /** `per`: undos per person per game; `owners`: the people (bots never undo); `used`: counts from a save. */
  constructor(readonly per: number, readonly owners: number[], used: Record<number, number> = {}) {
    for (const o of owners) this.used.set(o, used[o] ?? 0);
  }

  /** Undos `owner` has left this game. */
  left(owner: number): number {
    return this.owners.includes(owner) ? Math.max(0, this.per - (this.used.get(owner) ?? 0)) : 0;
  }

  /** Before a move: keep how things were. Only people's moves are kept. */
  push(frame: UndoFrame<C>) {
    if (!this.owners.includes(frame.owner)) return;
    // A move by someone else ends whatever was kept (the turn moved on).
    if (this.frames.length && this.frames[0]!.owner !== frame.owner) this.frames = [];
    this.frames.push(frame);
  }

  /** New dice appeared (any roll): nothing before them can be undone any more. */
  clear() {
    this.frames = [];
  }

  /** Whether `owner` can undo now: a move they chose is kept, and they have undos left. */
  canUndo(owner: number): boolean {
    return this.left(owner) > 0 && this.frames.some((f) => f.owner === owner && f.picked);
  }

  /**
   * Takes back `owner`'s last chosen move (and any move with nothing to choose that followed it), costing one
   * undo: returns the frame to restore, or null when there is nothing to undo.
   */
  undo(owner: number): UndoFrame<C> | null {
    if (!this.canUndo(owner)) return null;
    let f = this.frames.pop()!;
    while (!f.picked) f = this.frames.pop()!;
    this.used.set(owner, (this.used.get(owner) ?? 0) + 1);
    return f;
  }

  /** Undos each person used this game (for the record's meta and the save). Only people who used any. */
  usedCounts(): Record<number, number> {
    return Object.fromEntries([...this.used].filter(([, n]) => n > 0));
  }
}

/**
 * Whether the turn-ends window opens after `owner`'s move from `before` to `after`: only when the move hands
 * the turn on (to another person, or the game ends) or finishes that person, and they can still undo. Within
 * their own turn (dice left, or their own extra roll), Undo just sits beside the tray with no timer.
 */
export function windowAfter(before: GameState, after: GameState, owner: number, canUndo: boolean): boolean {
  if (!canUndo) return false;
  if (after.phase === 'over') return true;
  const nowOwner = after.players[after.current]!.owner;
  if (nowOwner !== owner) return true;
  const done = (s: GameState) => s.players.filter((p) => p.owner === owner).every((p) => p.tokens.every((t) => t === FINISHED));
  return done(after) && !done(before);
}
