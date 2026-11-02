// The rarely used screens, loaded on first use (#98): replay, review, store, the bench page, the palace
// cutscene and the share card stay out of the startup bundle. On the web, a chunk never fetched would fail
// if the connection dropped later ("Both modes play offline"), so prefetchAtIdle() fetches them all at idle
// once the home screen is up; the APK has every chunk locally anyway. A failed import shows loadFailed()
// with a retry, never a blank screen.

/** A loader that imports once and remembers it; a failed import is forgotten, so a retry imports again. */
export function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => {
    p ??= load().catch((e: unknown) => {
      p = null;
      throw e;
    });
    return p;
  };
}

export const screens = {
  replay: lazy(() => import('./replayScreen')),
  review: lazy(() => import('./reviewScreen')),
  store: lazy(() => import('./storeScreen')),
  bench: lazy(() => import('./bench')),
  palace: lazy(() => import('./palace')),
  shareCard: lazy(() => import('./shareCard')),
};

/**
 * Fetches every lazy screen at idle, at low priority, after the first paint (errors ignored: the next use
 * retries). In the APK every chunk is local, so this is only a few cheap file reads there.
 */
export function prefetchAtIdle(loaders: (() => Promise<unknown>)[] = Object.values(screens)) {
  const run = () => loaders.forEach((l) => void l().catch(() => undefined));
  const idle = (globalThis as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(run, { timeout: 10_000 });
  else setTimeout(run, 2000);
}

/**
 * The screen shown when a lazy screen couldn't load: a retry, and Back when there's somewhere to go (every
 * caller passes one today; without it the Android Back button has nothing to press here).
 */
export function loadFailed(retry: () => void, back?: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'screen loadfail';
  // The check-in card's look; data-act=back is also what the Android Back button presses.
  el.innerHTML = `<div class="menu-ov"><div class="box"><h2>Couldn't load this screen</h2><p class="sub">Check your connection, then try again.</p><button class="b3 green disp" data-act="retry">TRY AGAIN</button>${back ? '<button class="later" data-act="back">Back</button>' : ''}</div></div>`;
  el.querySelector('[data-act=retry]')!.addEventListener('click', retry);
  el.querySelector('[data-act=back]')?.addEventListener('click', () => back?.());
  return el;
}

// Each stage's navigation count: every screen put on it (setScreen) or asked for (show) counts one, so a
// lazy screen whose chunk arrives after the player has gone elsewhere is dropped, not put over the newer one.
const navs = new WeakMap<object, number>();
const navigate = (stage: HTMLElement) => {
  const n = (navs.get(stage) ?? 0) + 1;
  navs.set(stage, n);
  return n;
};

/** Puts `screen` on `stage` (every navigation goes through here or show(), so a late lazy screen can tell it's stale). */
export function setScreen(stage: HTMLElement, screen: HTMLElement) {
  navigate(stage);
  stage.replaceChildren(screen);
}

/**
 * Puts a lazily loaded screen on `stage`, or loadFailed() with a retry if its chunk can't load. Nothing
 * happens if the player has moved on (another setScreen or show) while the chunk was loading.
 */
export async function show<M>(stage: HTMLElement, load: () => Promise<M>, render: (m: M) => HTMLElement, back?: () => void): Promise<void> {
  const me = navigate(stage);
  const current = () => navs.get(stage) === me;
  try {
    const m = await load();
    if (current()) stage.replaceChildren(render(m));
  } catch {
    if (current()) stage.replaceChildren(loadFailed(() => void show(stage, load, render, back), back));
  }
}
