// Copying text that works everywhere (#237): the web clipboard first; in the Android app, where the WebView's
// navigator.clipboard can fail (no permission, no focus, or not there at all), the official Capacitor plugin.
import { Capacitor } from '@capacitor/core';

/** Copies `s`; true when it's on the clipboard. Never throws. */
export async function copyText(s: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch {
    // Refused or failed: the app's own clipboard below.
  }
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const { Clipboard } = await import('@capacitor/clipboard');
    await Clipboard.write({ string: s });
    return true;
  } catch {
    return false;
  }
}

/**
 * #237: copies `s` and says so on a copy button: its icon turns to a tick and `label` reads "Copied" for a moment
 * (or "Couldn't copy", when nothing was copied), then both go back.
 */
export function copyWithFeedback(s: string, btn: HTMLElement | null, label: HTMLElement | null, rest = 'Tap to copy', icons?: { copy: string; tick: string }): void {
  void copyText(s).then((ok) => {
    if (label) label.textContent = ok ? 'Copied' : 'Couldn’t copy';
    if (btn && icons && ok) btn.innerHTML = icons.tick;
    btn?.classList.toggle('done', ok);
    setTimeout(() => {
      if (label) label.textContent = rest;
      if (btn && icons) btn.innerHTML = icons.copy;
      btn?.classList.remove('done');
    }, 1600);
  });
}
