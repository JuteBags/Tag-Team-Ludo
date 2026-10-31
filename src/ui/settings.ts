import type { BotLevel } from '../engine';

// Player preferences, kept in localStorage (per device). Every read and write is guarded: storage
// can be blocked, and then the defaults simply apply for the session.

export type DiceFace = 'top' | 'front';
/** How the die is thrown. More styles (cups, throws) can be unlocked later. */
export type ThrowStyle = 'cup' | 'toss' | 'skullcup' | 'cone' | 'cups3' | 'gun';

interface Settings {
  /** Which face of the landed die is the roll: the one facing up, or the one facing you. */
  diceFace: DiceFace;
  throwStyle: ThrowStyle;
  /** Board look (themes.ts). */
  theme: Theme;
  /** A shape for each colour on its pawns and base, for colour-blind players. */
  symbols: boolean;
  /** How well bots play; the last choice is kept. */
  botLevel: BotLevel;
  /** Doubles (pairs) in new games; off is classic single-token Ludo. */
  doubles: boolean;
  /** Names people gave themselves, by seat: With friends seats, and your own name vs Computer. */
  friendNames: string[];
  myName: string;
  /** Store skins in use (skins.ts); the board is `theme` and the thrower `throwStyle`. */
  equipped: { pawn: string; dice: string };
}

export type Theme = 'classic' | 'wood' | 'dark' | 'metal' | 'tron' | 'halloween';

const KEY = 'ludo-settings';
const DEFAULTS: Settings = { diceFace: 'top', throwStyle: 'cup', theme: 'classic', symbols: false, botLevel: 'normal', doubles: true, friendNames: [], myName: '', equipped: { pawn: 'classic', dice: 'classic' } };

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
