// Phone integration: the Android back button (Escape on the web and desktop) and keeping the screen
// awake during a game.
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

/**
 * Calls `onBack` for the Android back button and for Escape. It returns false when there is nothing
 * left to go back to (the home screen), and then the app closes on Android.
 */
export function handleBack(onBack: () => boolean) {
  if (Capacitor.isNativePlatform()) {
    void App.addListener('backButton', () => {
      if (!onBack()) void App.exitApp();
    });
  }
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') onBack();
  });
}

/** Runs `f` when the app goes to the background (switching apps, a call, the screen turning off). */
export function onHide(f: () => void) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') f();
  });
}

// ---------- keep the screen awake ----------
// The Screen Wake Lock API works in Android's WebView. The browser drops the lock whenever the app is
// hidden, so it is taken again when the game comes back into view.

let lock: WakeLockSentinel | null = null;
let wanted = false;

async function take() {
  if (lock || !wanted || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => (lock = null));
  } catch {
    // Not allowed here (battery saver, an old WebView): the screen just times out as usual.
  }
}

document.addEventListener('visibilitychange', () => void take());

/** Keeps the screen on (during a game) or lets it sleep again. */
export function keepAwake(on: boolean) {
  wanted = on;
  if (on) void take();
  else {
    void lock?.release();
    lock = null;
  }
}
