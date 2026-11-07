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
