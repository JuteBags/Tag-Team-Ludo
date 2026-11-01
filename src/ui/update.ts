// The update prompt: on the home screen, when the site has a newer version than this app (CI publishes
// download/version.json with every release), offer it once. "Not now" keeps it away for that version for
// a day. Offline, or a failed fetch: nothing happens.
import { Capacitor } from '@capacitor/core';

const SITE = 'https://jutebags.github.io/Tag-Team-Ludo/';
const KEY = 'ludo-update-later';
/** How long "Not now" holds the prompt back for the same version. */
const LATER_MS = 24 * 3600 * 1000;

export interface VersionInfo {
  version: string;
  notes?: string;
}

/** True when version `a` (like "2.5.0") is newer than `b`, by major, minor, then patch. */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Whether to show the prompt for `latest`: newer than `current`, and not put off for it in the last day. */
export function shouldPrompt(latest: VersionInfo, current: string, later: { version: string; at: number } | null, now: number): boolean {
  if (!isNewer(latest.version, current)) return false;
  return !(later && later.version === latest.version && now - later.at < LATER_MS);
}

/** The first line of the release notes, without markdown, for the prompt. */
export function headline(notes = ''): string {
  const line = notes.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '';
  return line.replace(/\*\*|__|`/g, '').replace(/^[-*]\s+/, '').trim().slice(0, 160);
}

function readLater(): { version: string; at: number } | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
}

/** Fetches the latest version (4 s at most); null when offline or anything fails. */
async function latest(): Promise<VersionInfo | null> {
  try {
    const r = await fetch(`${SITE}download/version.json`, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    return r.ok ? ((await r.json()) as VersionInfo) : null;
  } catch {
    return null;
  }
}

/** Checks for a newer version and, if there is one to offer, shows the prompt over `screen`. */
export async function offerUpdate(screen: HTMLElement): Promise<void> {
  const info = await latest();
  if (!info || !screen.isConnected || !shouldPrompt(info, __APP_VERSION__, readLater(), Date.now())) return;
  const ov = document.createElement('div');
  ov.className = 'menu-ov update-ov';
  const news = headline(info.notes);
  ov.innerHTML = `<div class="box"><h2>Update ready</h2><p class="sub">Version ${info.version} is out (you have ${__APP_VERSION__}).</p>${news ? `<p class="news">${news.replace(/</g, '&lt;')}</p>` : ''}
    <button class="b3 green disp" data-act="update">UPDATE</button><button class="b3 blue disp" data-act="later">NOT NOW</button></div>`;
  ov.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'later' || e.target === ov) {
      try {
        localStorage.setItem(KEY, JSON.stringify({ version: info.version, at: Date.now() }));
      } catch {
        // Storage blocked: the prompt may come back next time.
      }
      ov.remove();
    } else if (act === 'update') {
      // Android: the new APK from the site (the system browser downloads it). Web: the new build loads.
      if (Capacitor.isNativePlatform()) window.open(`${SITE}download/tag-team-ludo.apk`, '_system');
      else location.reload();
      ov.remove();
    }
  });
  screen.appendChild(ov);
}
