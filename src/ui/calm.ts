// A calm board when nothing happens (#98): after CALM_MS without a tap or a game step, the game screen gets
// the `calm` class, which stops its endless animations: the movable pawns' bob, the move preview's marching
// trail, the inferno dice's glow, and the dice box's and ROLL button's pulse (cheap per frame on the
// compositor, but 60 frames a second for as long as a player waits to roll: battery). Movable pawns keep a
// still "you can move these" pose (raised); the active corner's glow, the button and the hint carry the turn.
// Any tap, game step, or the app coming back into view brings the motion back.

/** How long the board waits before it calms down: long enough that a player reading it sees the cues. */
export const CALM_MS = 9000;

interface Target {
  classList: { add(c: string): void; remove(c: string): void };
  addEventListener(type: 'pointerdown', f: () => void, o?: { capture?: boolean; passive?: boolean }): void;
  removeEventListener(type: 'pointerdown', f: () => void, o?: { capture?: boolean }): void;
}

/** The page, for its visibility (the app put down and picked up again; Android's WebView fires it on resume). */
interface Page {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', f: () => void): void;
  removeEventListener(type: 'visibilitychange', f: () => void): void;
}

/**
 * Calms `el` after `ms` without a tap on it, a poke(), or the page coming back into view; stop() ends it
 * (the screen goes away).
 */
export function calmAfter(el: Target, ms = CALM_MS, page: Page | undefined = typeof document !== 'undefined' ? document : undefined) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poke = () => {
    el.classList.remove('calm');
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.add('calm'), ms);
  };
  // Someone who put the phone down and comes back sees the cues move again.
  const shown = () => {
    if (page?.visibilityState === 'visible') poke();
  };
  el.addEventListener('pointerdown', poke, { capture: true, passive: true });
  page?.addEventListener('visibilitychange', shown);
  poke();
  return {
    /** Something happened (a roll, a move, a turn): motion again, and the wait starts over. */
    poke,
    stop() {
      clearTimeout(timer);
      el.removeEventListener('pointerdown', poke, { capture: true });
      page?.removeEventListener('visibilitychange', shown);
      el.classList.remove('calm');
    },
  };
}
