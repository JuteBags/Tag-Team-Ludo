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

/** Whether `stored` accepts `version` (the current one unless given). */
export const acceptedFor = (stored: { version: number } | null | undefined, version = LEGAL_VERSION) => !!stored && stored.version >= version;

/** Whether this device has accepted the current Privacy note and Terms of use. */
export const hasAcceptedTerms = () => acceptedFor(settings.legal);

/** Records the current version as accepted, now (or at `at`). */
export function acceptTerms(at = Date.now()) {
  saveSetting('legal', { version: LEGAL_VERSION, at });
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
 * The first-launch sheet: a line on what the game keeps, the two links, and Accept. Not a `.sheet`, so the back
 * button doesn't close it (there's nothing to go back to). `onAccept` runs once Accept is tapped.
 */
export function termsSheet(host: HTMLElement, onAccept: () => void): HTMLElement {
  const ov = document.createElement('div');
  ov.className = 'menu-ov terms-ov';
  ov.innerHTML = `<div class="box"><h2>Before you play</h2>
    <p class="sub">Offline play stays on your device. Online play uses a guest account with a name you choose. Please read and accept to continue.</p>
    ${legalLinks()}
    <button class="b3 green disp" data-act="accept">ACCEPT</button></div>`;
  wireLegalLinks(ov, host);
  ov.querySelector('[data-act=accept]')!.addEventListener('click', () => {
    acceptTerms();
    ov.remove();
    onAccept();
  });
  host.appendChild(ov);
  return ov;
}

/**
 * Resolves once the current texts are accepted: at once if they are, else after the first-launch sheet's Accept.
 * The home screen calls it on launch; online play (#204) calls it before it connects. `show` is the sheet (for
 * tests).
 */
export function requireTerms(host: HTMLElement, show: (host: HTMLElement, onAccept: () => void) => unknown = termsSheet): Promise<void> {
  if (hasAcceptedTerms()) return Promise.resolve();
  return new Promise((done) => {
    show(host, done);
  });
}
