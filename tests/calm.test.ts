// A calm board (src/ui/calm.ts, #98): the `calm` class comes after CALM_MS without a tap or a game step, any
// tap or step takes it away and starts the wait over, and stop() leaves the screen as it was.
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error: the project has no @types/node; Vitest runs on Node.
import { readFileSync } from 'node:fs';
import { CALM_MS, calmAfter } from '../src/ui/calm';

/** Just enough of an element: its classes and its pointerdown listener. */
function fakeEl() {
  const classes = new Set<string>();
  let tap: (() => void) | null = null;
  return {
    classes,
    tap: () => tap?.(),
    classList: { add: (c: string) => void classes.add(c), remove: (c: string) => void classes.delete(c) },
    addEventListener: (_: string, f: () => void) => void (tap = f),
    removeEventListener: () => void (tap = null),
  };
}

describe('calm board', () => {
  it('calms after CALM_MS (8-10 s, so a player reading the board still sees the cues)', () => {
    expect(CALM_MS).toBeGreaterThanOrEqual(8000);
    expect(CALM_MS).toBeLessThanOrEqual(10000);
    vi.useFakeTimers();
    const el = fakeEl();
    const c = calmAfter(el);
    vi.advanceTimersByTime(CALM_MS - 1);
    expect(el.classes.has('calm')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(el.classes.has('calm')).toBe(true);
    c.stop();
    vi.useRealTimers();
  });

  it('a tap or a game step brings the motion back and starts the wait over', () => {
    vi.useFakeTimers();
    const el = fakeEl();
    const c = calmAfter(el);
    vi.advanceTimersByTime(CALM_MS);
    expect(el.classes.has('calm')).toBe(true);
    el.tap();
    expect(el.classes.has('calm')).toBe(false);
    vi.advanceTimersByTime(CALM_MS / 2);
    c.poke(); // a bot moved
    vi.advanceTimersByTime(CALM_MS - 1);
    expect(el.classes.has('calm')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(el.classes.has('calm')).toBe(true);
    c.stop();
    vi.useRealTimers();
  });

  it('stop() leaves the screen uncalmed and calms it no more', () => {
    vi.useFakeTimers();
    const el = fakeEl();
    const c = calmAfter(el);
    vi.advanceTimersByTime(CALM_MS);
    c.stop();
    expect(el.classes.has('calm')).toBe(false);
    vi.advanceTimersByTime(3 * CALM_MS);
    expect(el.classes.has('calm')).toBe(false);
    vi.useRealTimers();
  });

  it('the app coming back into view brings the motion back (#98: a phone put down and picked up)', () => {
    vi.useFakeTimers();
    const el = fakeEl();
    let shown: (() => void) | null = null;
    const page = {
      visibilityState: 'visible',
      addEventListener: (_: string, f: () => void) => void (shown = f),
      removeEventListener: () => void (shown = null),
    };
    const c = calmAfter(el, CALM_MS, page);
    vi.advanceTimersByTime(CALM_MS);
    expect(el.classes.has('calm')).toBe(true);
    // Hidden: nothing changes (nobody sees it).
    page.visibilityState = 'hidden';
    shown!();
    expect(el.classes.has('calm')).toBe(true);
    // Back in view: moving again, and the wait starts over.
    page.visibilityState = 'visible';
    shown!();
    expect(el.classes.has('calm')).toBe(false);
    vi.advanceTimersByTime(CALM_MS);
    expect(el.classes.has('calm')).toBe(true);
    c.stop();
    expect(shown).toBe(null);
    vi.useRealTimers();
  });

  it('calms the roll nudge too: the dice box and ROLL stop pulsing under .calm', () => {
    const css = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.calm \.dbox\.can-roll,\s*\.calm \.rollbtn\s*\{animation:none\}/);
  });
});
