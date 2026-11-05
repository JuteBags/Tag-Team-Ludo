// Haptics (#73): one feel per game moment, named for what happened, not how it feels, so a call site says
// haptics.feel('kill') and the patterns live here. In the app the native haptics engine plays them
// (@capacitor/haptics: real light / medium / heavy impacts, success and warning); on the web, short
// navigator.vibrate patterns where the browser allows them, else nothing.
//
// The rules (the approved design, #73):
// - Only the person's own moments: their taps, their tokens, their dice, their win. Bot-against-bot moves never
//   buzz (the call sites decide whose it is; in pass-the-phone every person counts).
// - The Vibration setting is the one control. Reduced motion doesn't mute it: that setting is about what moves
//   on screen, and a tap you feel isn't motion.
// - At most about two moments a second (MAX_PER_SECOND), however fast the game; a moment past that is dropped.
//   A new moment replaces the rest of one still playing (a pair kill's second hit, a win's lights).
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { settings } from './settings';

export type Moment =
  /** Tapping a token, a die or a landing marker. */
  | 'select'
  /** A token out of the house. */
  | 'release'
  /** Landing on a safe square or star. */
  | 'safe'
  /** A pair's move. */
  | 'pair'
  /** Your own roll of a 6. */
  | 'six'
  /** Three 6s cancelled. */
  | 'bust'
  /** Your kill, on the finisher's hit; a pair kill hits twice. */
  | 'kill'
  | 'killPair'
  /** Your token killed. */
  | 'killed'
  /** A token home. */
  | 'home'
  /** Winning the game. */
  | 'win';

export type Feel = { impact: 'light' | 'medium' | 'heavy' } | { notify: 'success' | 'warning' } | { select: true };
/** A moment's pattern: feels with the wait (ms) before each. */
export type Pattern = { at: number; feel: Feel }[];

const L = { impact: 'light' } as const;
const M = { impact: 'medium' } as const;
const H = { impact: 'heavy' } as const;

export const PATTERNS: Record<Moment, Pattern> = {
  select: [{ at: 0, feel: { select: true } }],
  release: [{ at: 0, feel: L }],
  safe: [{ at: 0, feel: L }],
  pair: [{ at: 0, feel: M }, { at: 80, feel: M }],
  six: [{ at: 0, feel: M }],
  bust: [{ at: 0, feel: { notify: 'warning' } }],
  kill: [{ at: 0, feel: H }],
  // The pair finishers strike twice, 140 ms apart (the doubled crack, the two blades).
  killPair: [{ at: 0, feel: H }, { at: 140, feel: H }],
  killed: [{ at: 0, feel: { notify: 'warning' } }],
  home: [{ at: 0, feel: { notify: 'success' } }],
  win: [{ at: 0, feel: { notify: 'success' } }, { at: 260, feel: L }, { at: 120, feel: L }],
};

/** Moments in any rolling second, at most. */
export const MAX_PER_SECOND = 2;

export interface Driver {
  play(f: Feel): void;
}

/** The phone's haptics engine in the app; navigator.vibrate on the web; nothing where neither exists. */
export function defaultDriver(): Driver | null {
  if (Capacitor.isNativePlatform()) {
    const quiet = (p: Promise<unknown>) => void p.catch(() => undefined);
    const STYLE = { light: ImpactStyle.Light, medium: ImpactStyle.Medium, heavy: ImpactStyle.Heavy };
    return {
      play(f) {
        if ('impact' in f) quiet(Haptics.impact({ style: STYLE[f.impact] }));
        else if ('notify' in f) quiet(Haptics.notification({ type: f.notify === 'success' ? NotificationType.Success : NotificationType.Warning }));
        else quiet(Haptics.selectionStart().then(() => Haptics.selectionChanged()).then(() => Haptics.selectionEnd()));
      },
    };
  }
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return null;
  // Short web patterns: the browser's own buzz is coarser than a phone's engine, so these stay brief.
  const WEB: Record<string, number | number[]> = { light: 12, medium: 22, heavy: 40, success: [25, 60, 25], warning: [40, 50, 40], select: 6 };
  return {
    play(f) {
      const key = 'impact' in f ? f.impact : 'notify' in f ? f.notify : 'select';
      try {
        navigator.vibrate(WEB[key]!);
      } catch {
        // Not every WebView allows vibration.
      }
    },
  };
}

export interface Clock {
  now(): number;
  later(f: () => void, ms: number): unknown;
  cancel(t: unknown): void;
}

const realClock: Clock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  later: (f, ms) => setTimeout(f, ms),
  cancel: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

/** Haptics over a driver, a clock and the on/off switch: injected, so tests can check every rule. */
export function createHaptics(driver: Driver | null, on: () => boolean, clock: Clock = realClock) {
  const recent: number[] = [];
  let pending: unknown[] = [];
  return {
    /** Whether this device can buzz at all (the Settings switch is hidden when it can't). */
    available: driver !== null,
    /** Plays a moment, if vibration is on and the last second hasn't had MAX_PER_SECOND already. */
    feel(m: Moment): boolean {
      if (!driver || !on()) return false;
      const t = clock.now();
      while (recent.length && t - recent[0]! >= 1000) recent.shift();
      if (recent.length >= MAX_PER_SECOND) return false;
      recent.push(t);
      pending.forEach((p) => clock.cancel(p));
      pending = [];
      let wait = 0;
      for (const step of PATTERNS[m]) {
        wait += step.at;
        if (wait === 0) driver.play(step.feel);
        else pending.push(clock.later(() => driver.play(step.feel), wait));
      }
      return true;
    },
  };
}

export const haptics = createHaptics(defaultDriver(), () => settings.vibration);
