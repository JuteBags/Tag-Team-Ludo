// The Privacy note and Terms of use (#208): the texts bundled for offline reading, the first-launch sheet that
// asks to accept them once (again only when LEGAL_VERSION goes up), and the check online play makes before it
// connects. Accepting is stored with the settings as { version, at }. There's no reject path: playing on this
// device needs nothing, so Accept only records it. The texts' source is legal/*.md; the website's
// docs/privacy.html and docs/terms.html are made from them by tools/legal-site.mjs.
import privacyMd from '../../legal/PRIVACY.md?raw';
import termsMd from '../../legal/TERMS.md?raw';
import { legalHtml, legalTitle } from './legalText';
import { saveSetting, settings } from './settings';

/** The texts' version. Raise it (and the "Version N" line in both texts) to ask everyone to accept again. */
export const LEGAL_VERSION = 1;

export type LegalDoc = 'privacy' | 'terms';
export const LEGAL_MD: Record<LegalDoc, string> = { privacy: privacyMd, terms: termsMd };
/** The names the links use. */
export const LEGAL_NAME: Record<LegalDoc, string> = { privacy: 'Privacy note', terms: 'Terms of use' };

/** A stored answer: the version it was for, when, and `declined` for Not now. */
export type LegalAnswer = { version: number; at: number; declined?: boolean };

/** Whether `stored` accepts `version` (the current one unless given). */
export const acceptedFor = (stored: LegalAnswer | null | undefined, version = LEGAL_VERSION) => !!stored && !stored.declined && stored.version >= version;
/** Whether `stored` answers `version` at all (accepted, or Not now): the launch sheet then doesn't ask again. */
export const answeredFor = (stored: LegalAnswer | null | undefined, version = LEGAL_VERSION) => !!stored && stored.version >= version;

/** Whether this device has accepted the current Privacy note and Terms of use (online play needs it). */
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

/** A text in a sheet: the scrolling settings-style sheet with its title, the text, and DONE. */
export function legalSheet(host: HTMLElement, doc: LegalDoc): HTMLElement {
  const md = LEGAL_MD[doc];
  const ov = document.createElement('div');
  ov.className = 'menu-ov sheet legal';
  ov.innerHTML = `<div class="box"><button class="x" data-act="close" aria-label="Close">×</button><h2>${LEGAL_NAME[doc]}</h2><div class="legaltext">${legalHtml(md, 3)}</div><button class="b3 green disp" data-act="close">DONE</button></div>`;
  ov.setAttribute('aria-label', legalTitle(md));
  ov.addEventListener('click', (e) => {
    if (e.target === ov || (e.target as Element).closest('[data-act=close]')) ov.remove();
  });
  host.appendChild(ov);
  return ov;
}

/** The two links, as buttons: tapping one opens its text over whatever is showing. */
export const legalLinks = () =>
  `<div class="legallinks"><button data-legal="privacy">${LEGAL_NAME.privacy}</button><i aria-hidden="true">·</i><button data-legal="terms">${LEGAL_NAME.terms}</button></div>`;

/** Opens the text a [data-legal] button inside `root` names, over `host`. */
export function wireLegalLinks(root: HTMLElement, host: HTMLElement) {
  root.addEventListener('click', (e) => {
    const doc = (e.target as Element).closest<HTMLElement>('[data-legal]')?.dataset.legal as LegalDoc | undefined;
    if (doc) legalSheet(host, doc);
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
    <p class="sub">${online ? 'Online play needs your OK to the Privacy note and Terms of use: it uses a guest account with a name you choose.' : 'Offline play stays on your device. Online play uses a guest account with a name you choose.'}</p>
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
