// Board themes and colour-blind symbols. A theme is only a set of CSS variables (defined at the top of
// styles.css) that the board art reads, so switching is instant and every theme costs a few bytes.
import { saveSetting, settings, type Theme } from './settings';

export const THEMES: { id: Theme; name: string; swatch: string }[] = [
  { id: 'classic', name: 'Classic', swatch: 'linear-gradient(135deg,#fff 0 50%,#f3ab3c 50%)' },
  { id: 'wood', name: 'Wooden', swatch: 'linear-gradient(135deg,#f6e2b8 0 50%,#7a4a22 50%)' },
  { id: 'dark', name: 'Dark', swatch: 'linear-gradient(135deg,#2c3858 0 50%,#7c8cff 50%)' },
];

/** Puts the saved theme and symbols setting on <html>. */
export function applyLook() {
  const root = document.documentElement;
  if (settings.theme === 'classic') delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
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
