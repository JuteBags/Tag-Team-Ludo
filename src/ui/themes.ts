// Board themes and colour-blind symbols. A theme is only a set of CSS variables (defined at the top of
// styles.css) that the board art reads, so switching is instant and every theme costs a few bytes.
import { saveSetting, settings, type Theme } from './settings';
import { findSkin, isUnlocked } from './skins';

export const THEMES: { id: Theme; name: string; swatch: string }[] = [
  { id: 'classic', name: 'Classic', swatch: 'linear-gradient(135deg,#fff 0 50%,#f3ab3c 50%)' },
  { id: 'wood', name: 'Wooden', swatch: 'linear-gradient(135deg,#f6e2b8 0 50%,#7a4a22 50%)' },
  { id: 'dark', name: 'Dark', swatch: 'linear-gradient(135deg,#2c3858 0 50%,#7c8cff 50%)' },
  { id: 'metal', name: 'Metal', swatch: 'linear-gradient(135deg,#eef2f7 0 50%,#5b6577 50%)' },
  { id: 'tron', name: 'Tron', swatch: 'linear-gradient(135deg,#02050a 0 48%,#00e5ff 48% 54%,#02050a 54% 76%,#ff8a1f 76% 81%,#02050a 81%)' },
  { id: 'halloween', name: 'Halloween', swatch: 'linear-gradient(135deg,#f7e2c4 0 50%,#ff7a1a 50% 75%,#6a2c91 75%)' },
];

/** Boards this player can use now (the Store unlocks the rest). */
export const usableThemes = () => THEMES.filter((t) => isUnlocked(findSkin('board', t.id)!));

/** Puts the saved theme and symbols setting on <html>. */
export function applyLook() {
  const root = document.documentElement;
  // A board that isn't unlocked (a test build's choice, opened in a release build) falls back to Classic.
  const theme = isUnlocked(findSkin('board', settings.theme) ?? findSkin('board', 'classic')!) ? settings.theme : 'classic';
  if (theme === 'classic') delete root.dataset.theme;
  else root.dataset.theme = theme;
  root.classList.toggle('symbols', settings.symbols);
}

export function setTheme(t: Theme) {
  saveSetting('theme', t);
  applyLook();
}

export function setSymbols(on: boolean) {
  saveSetting('symbols', on);
  applyLook();
}
