// The Store's catalogue (#35): every skin, its shelf and how it is unlocked. Skins only change the look:
// never the rules or the dice odds. Players see every skin; the new ones stay locked until their unlock
// rule is met. Developer builds (npm run dev, debug APKs) and builds with VITE_UNLOCK_ALL=1 open
// everything, so testers can try each skin while release builds keep them locked.
import { saveSetting, settings, type Theme, type ThrowStyle } from './settings';

export type Shelf = 'pawn' | 'dice' | 'thrower' | 'board';

/** How a skin is unlocked. Gold and achievements are planned (#35 phase 2); today they read as locked. */
export type Unlock =
  | { kind: 'free' }
  | { kind: 'soon' }
  | { kind: 'gold'; price: number }
  | { kind: 'achievement'; label: string };

export interface Skin {
  id: string;
  shelf: Shelf;
  name: string;
  /** One line under the name in the Store. */
  blurb: string;
  unlock: Unlock;
}

export const SHELVES: { id: Shelf; name: string }[] = [
  { id: 'pawn', name: 'Pawns' },
  { id: 'dice', name: 'Dice' },
  { id: 'thrower', name: 'Throwers' },
  { id: 'board', name: 'Boards' },
];

const free = { kind: 'free' } as const;
const gold = (price: number) => ({ kind: 'gold', price }) as const;

export const SKINS: Skin[] = [
  { id: 'classic', shelf: 'pawn', name: 'Classic', blurb: 'The glossy original', unlock: free },
  { id: 'skull', shelf: 'pawn', name: 'Skull', blurb: 'A Halloween special', unlock: gold(500) },
  { id: 'cone', shelf: 'pawn', name: 'Ice-cream', blurb: 'One scoop, extra sprinkles', unlock: gold(400) },
  { id: 'robot', shelf: 'pawn', name: 'Robot', blurb: 'Beep. Boop. Kill.', unlock: gold(600) },
  { id: 'knight', shelf: 'pawn', name: 'Knight', blurb: 'Borrowed from chess', unlock: gold(800) },

  { id: 'classic', shelf: 'dice', name: 'Classic', blurb: 'White, with red ones and sixes', unlock: free },
  { id: 'bone', shelf: 'dice', name: 'Bone', blurb: 'Carved for Halloween', unlock: gold(300) },
  { id: 'tron', shelf: 'dice', name: 'Tron', blurb: 'Black glass, cyan light', unlock: gold(700) },
  { id: 'gold', shelf: 'dice', name: 'Gold', blurb: 'Solid, shiny, smug', unlock: gold(1000) },
  { id: 'glass', shelf: 'dice', name: 'Glass', blurb: 'Clear as crystal', unlock: gold(500) },

  { id: 'cup', shelf: 'thrower', name: 'Dice cup', blurb: 'Shaken and thrown', unlock: free },
  { id: 'toss', shelf: 'thrower', name: 'Toss', blurb: 'A flick of the wrist', unlock: free },
  { id: 'skullcup', shelf: 'thrower', name: 'Skull cup', blurb: 'Rattled in a skull', unlock: gold(400) },
  { id: 'cone', shelf: 'thrower', name: 'Ice-cream cone', blurb: 'Drops out of a cone', unlock: gold(400) },
  { id: 'cups3', shelf: 'thrower', name: 'Three cups', blurb: 'Shuffled like a street trick', unlock: gold(600) },
  { id: 'gun', shelf: 'thrower', name: 'Dice gun', blurb: 'Fired onto the board', unlock: gold(900) },

  { id: 'classic', shelf: 'board', name: 'Classic', blurb: 'Ivory tiles, gold frame', unlock: free },
  { id: 'wood', shelf: 'board', name: 'Wooden', blurb: 'Warm and hand-made', unlock: free },
  { id: 'dark', shelf: 'board', name: 'Dark', blurb: 'Easy on the eyes', unlock: free },
  { id: 'metal', shelf: 'board', name: 'Metal', blurb: 'Brushed steel and rivets', unlock: gold(600) },
  { id: 'tron', shelf: 'board', name: 'Tron', blurb: 'Black glass and lines of light', unlock: gold(1200) },
  { id: 'halloween', shelf: 'board', name: 'Halloween', blurb: 'Pumpkins and purple fog', unlock: gold(800) },
];

/**
 * Developer and test builds open every skin; release builds keep the locked ones locked. In a test build,
 * `localStorage['ludo-dev-locks'] = '1'` shows the Store as players see it, to test buying.
 */
const devLocks = () => {
  try {
    return localStorage.getItem('ludo-dev-locks') === '1';
  } catch {
    return false;
  }
};
export const UNLOCK_ALL = (import.meta.env.DEV || import.meta.env.VITE_UNLOCK_ALL === '1') && !devLocks();

const key = (s: Skin) => `${s.shelf}:${s.id}`;
export const owns = (s: Skin) => settings.owned.includes(key(s));

export const shelfSkins = (shelf: Shelf) => SKINS.filter((s) => s.shelf === shelf);
export const findSkin = (shelf: Shelf, id: string) => SKINS.find((s) => s.shelf === shelf && s.id === id);
export const isUnlocked = (s: Skin, all = UNLOCK_ALL) => all || s.unlock.kind === 'free' || owns(s);

/** What a locked skin's badge says. */
export function lockLabel(s: Skin): string {
  const u = s.unlock;
  return u.kind === 'gold' ? `${u.price}` : u.kind === 'achievement' ? u.label : u.kind === 'soon' ? 'Coming soon' : '';
}

/** The skin in use on a shelf: the saved choice while it's unlocked, otherwise the shelf's free default. */
export function equipped(shelf: Shelf, all = UNLOCK_ALL): Skin {
  const id = shelf === 'board' ? settings.theme : shelf === 'thrower' ? settings.throwStyle : settings.equipped[shelf];
  const s = findSkin(shelf, id);
  return s && isUnlocked(s, all) ? s : shelfSkins(shelf)[0]!;
}

/** Puts a skin to use. Locked skins can't be used. */
export function equip(s: Skin, all = UNLOCK_ALL): boolean {
  if (!isUnlocked(s, all)) return false;
  if (s.shelf === 'board') saveSetting('theme', s.id as Theme);
  else if (s.shelf === 'thrower') saveSetting('throwStyle', s.id as ThrowStyle);
  else saveSetting('equipped', { ...settings.equipped, [s.shelf]: s.id });
  return true;
}

/** Spends gold on a skin: true if it was bought (and is now owned). */
export function buy(s: Skin): boolean {
  if (s.unlock.kind !== 'gold' || owns(s) || settings.gold < s.unlock.price) return false;
  saveSetting('gold', settings.gold - s.unlock.price);
  saveSetting('owned', [...settings.owned, key(s)]);
  return true;
}

/** Adds gold earned by playing. */
export const earn = (n: number) => saveSetting('gold', settings.gold + n);

/** The cheapest skin still to buy: the next goal shown after a game. */
export function nextGoal(): Skin | undefined {
  return SKINS.filter((s) => s.unlock.kind === 'gold' && !owns(s)).sort((a, b) => (a.unlock as { price: number }).price - (b.unlock as { price: number }).price)[0];
}
