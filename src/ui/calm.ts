// A calm board when nothing happens (#98): after CALM_MS without a tap or a game step, the game screen gets
// the `calm` class, which stops its endless animations that repaint every frame: the movable pawns' bob
// (an SVG transform), the move preview's marching trail, and the inferno dice's glow. Movable pawns keep a
// still "you can move these" pose (raised) instead of nothing. Any tap or game step brings the motion back.
// The dice box's pulse stays: it's an HTML transform, cheap for the compositor.

/** How long the board waits before it calms down: long enough that a player reading it sees the cues. */
export const CALM_MS = 9000;

interface Target {
  classList: { add(c: string): void; remove(c: string): void };
  addEventListener(type: 'pointerdown', f: () => void, o?: { capture?: boolean; passive?: boolean }): void;
  removeEventListener(type: 'pointerdown', f: () => void, o?: { capture?: boolean }): void;
}

/** Calms `el` after `ms` without a tap on it or a poke(); stop() ends it (the screen goes away). */
export function calmAfter(el: Target, ms = CALM_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poke = () => {
    el.classList.remove('calm');
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.add('calm'), ms);
  };
  el.addEventListener('pointerdown', poke, { capture: true, passive: true });
  poke();
  return {
    /** Something happened (a roll, a move, a turn): motion again, and the wait starts over. */
    poke,
    stop() {
      clearTimeout(timer);
      el.removeEventListener('pointerdown', poke, { capture: true });
      el.classList.remove('calm');
    },
  };
}
