// Player preferences, kept in localStorage (per device). Every read and write is guarded: storage
// can be blocked, and then the defaults simply apply for the session.

export type DiceFace = 'top' | 'front';
/** How the die is thrown. More styles (cups, throws) can be unlocked later. */
export type ThrowStyle = 'cup' | 'toss';

interface Settings {
  /** Which face of the landed die is the roll: the one facing up, or the one facing you. */
  diceFace: DiceFace;
  throwStyle: ThrowStyle;
}

const KEY = 'ludo-settings';
const DEFAULTS: Settings = { diceFace: 'top', throwStyle: 'cup' };

function load(): Settings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings: Settings = load();

export function saveSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  settings[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Not saved; it still applies for this session.
  }
}
