// Privacy & Terms (#208): one document (the terms of use, then the privacy note), bundled for offline reading;
// the first-launch sheet that asks once (Accept or Not now; again only when LEGAL_VERSION goes up), and the check
// online play makes before it connects (it needs Accept). The answer is stored with the settings as
// { version, at, declined? }. The source is legal/LEGAL.md; the website's docs/legal.html is made from it by
// tools/legal-site.mjs (docs/privacy.html and docs/terms.html redirect there).
import legalMd from '../../legal/LEGAL.md?raw';
import { legalHtml, legalTitle } from './legalText';
import { saveSetting, settings } from './settings';

/**
 * The document's version (its "Version N" line says the same; tests/legal.test.ts checks). Everyone who accepted an
 * older one is asked again, so bump it **at most once per release**, and only when the wording changed since the
 * last *release* (not since the last commit). 1 is the first released text (the first release with online play:
 * rooms, chat and friends).
 */
export const LEGAL_VERSION = 1;

export const LEGAL_MD = legalMd;
/** What the link and the sheet are called. */
export const LEGAL_NAME = 'Privacy & Terms';

/** A stored answer: the version it was for, when, and `declined` for Not now. */
export type LegalAnswer = { version: number; at: number; declined?: boolean };

/** Whether `stored` accepts `version` (the current one unless given). */
export const acceptedFor = (stored: LegalAnswer | null | undefined, version = LEGAL_VERSION) => !!stored && !stored.declined && stored.version >= version;
/** Whether `stored` answers `version` at all (accepted, or Not now): the launch sheet then doesn't ask again. */
export const answeredFor = (stored: LegalAnswer | null | undefined, version = LEGAL_VERSION) => !!stored && stored.version >= version;

/** Whether this device has accepted the current Privacy & Terms (online play needs it). */
export const hasAcceptedTerms = () => acceptedFor(settings.legal);
/** Whether this device has answered the current texts (accepted or Not now). */
export const answeredTerms = () => answeredFor(settings.legal);

/** Records the current version as accepted, now (or at `at`). */
export function acceptTerms(at = Date.now()) {
  saveSetting('legal', { version: LEGAL_VERSION, at });
}
/** Records Not now for the current version: offline play goes on, online play asks again. */
export function declineTerms(at = Date.now()) {
  saveSetting('legal', { version: LEGAL_VERSION, at, declined: true });
}

/** Privacy & Terms in a sheet: the scrolling settings-style sheet with its title, the text, and DONE. */
export function legalSheet(host: HTMLElement): HTMLElement {
  const md = LEGAL_MD;
  const ov = document.createElement('div');
  ov.className = 'menu-ov sheet legal';
  ov.innerHTML = `<div class="box"><button class="x" data-act="close" aria-label="Close">×</button><h2>${LEGAL_NAME}</h2><div class="legaltext">${legalHtml(md, 3)}</div><button class="b3 green disp" data-act="close">DONE</button></div>`;
  ov.setAttribute('aria-label', legalTitle(md));
  ov.addEventListener('click', (e) => {
    if (e.target === ov || (e.target as Element).closest('[data-act=close]')) ov.remove();
  });
  host.appendChild(ov);
  return ov;
}

/** The one link, as a button: tapping it opens Privacy & Terms over whatever is showing. */
export const legalLinks = () => `<div class="legallinks"><button data-legal="all">${LEGAL_NAME}</button></div>`;

/** Opens Privacy & Terms when a [data-legal] button inside `root` is tapped, over `host`. */
export function wireLegalLinks(root: HTMLElement, host: HTMLElement) {
  root.addEventListener('click', (e) => {
    if ((e.target as Element).closest('[data-legal]')) legalSheet(host);
  });
}

/**
 * The terms sheet: a line on what the game keeps, the two links, Accept and Not now. `online`: asked before online
 * play, which needs it. `onAnswer(true)` once Accept is tapped, `onAnswer(false)` on Not now (also the back
 * button, which taps a .menu-ov's [data-act=later]).
 */
export function termsSheet(host: HTMLElement, onAnswer: (accepted: boolean) => void, online = false): HTMLElement {
  const ov = document.createElement('div');
  ov.className = 'menu-ov terms-ov';
  ov.innerHTML = `<div class="box"><h2>${online ? 'Play online' : 'Before you play'}</h2>
    <p class="sub">${online ? 'Online play needs your OK to Privacy & Terms: it uses a guest account with a name you choose.' : 'Offline play stays on your device. Online play uses a guest account with a name you choose.'}</p>
    ${legalLinks()}
    <button class="b3 green disp" data-act="accept">ACCEPT</button><button class="later" data-act="later">Not now</button></div>`;
  wireLegalLinks(ov, host);
  ov.addEventListener('click', (e) => {
    const act = (e.target as Element).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act !== 'accept' && act !== 'later') return;
    if (act === 'accept') acceptTerms();
    else declineTerms();
    ov.remove();
    onAnswer(act === 'accept');
  });
  host.appendChild(ov);
  return ov;
}

type Show = (host: HTMLElement, onAnswer: (accepted: boolean) => void, online?: boolean) => unknown;

/**
 * First launch (the home screen): asks once, until the texts are answered (accepted or Not now), and again only
 * when LEGAL_VERSION goes up. Resolves either way: offline play needs nothing. `show` is the sheet (for tests).
 */
export function offerTerms(host: HTMLElement, show: Show = termsSheet): Promise<void> {
  if (answeredTerms()) return Promise.resolve();
  return new Promise((done) => {
    show(host, () => done());
  });
}

/**
 * Before online play connects (#204): true at once if the texts are accepted; else the sheet, and true only if
 * Accept is tapped (Not now: no online play). Once accepted it never asks again, until the version goes up.
 */
export function requireTerms(host: HTMLElement, show: Show = termsSheet): Promise<boolean> {
  if (hasAcceptedTerms()) return Promise.resolve(true);
  return new Promise((done) => {
    show(host, done, true);
  });
}

const day = (at: number) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** Settings → About: the two links, whether they're accepted, and a way to accept them (online play needs it). */
export const legalAbout = () =>
  `<div class="set about"><span>About</span>${legalLinks()}<div class="legalstate">${aboutState()}</div></div>`;
const aboutState = () =>
  hasAcceptedTerms()
    ? `<small class="qh">Accepted on ${day(settings.legal!.at)}</small>`
    : `<small class="qh">Not accepted: online play needs it</small><button class="b3 blue disp" data-act="accept-terms">REVIEW AND ACCEPT</button>`;

/** Wires legalAbout's row inside `root`, with its texts and sheet over `host`. */
export function wireLegalAbout(root: HTMLElement, host: HTMLElement) {
  wireLegalLinks(root, host);
  root.addEventListener('click', (e) => {
    if (!(e.target as Element).closest('[data-act=accept-terms]')) return;
    termsSheet(host, () => (root.querySelector('.legalstate')!.innerHTML = aboutState()), true);
  });
}
