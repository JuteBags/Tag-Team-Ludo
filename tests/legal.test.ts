// The Privacy note and Terms of use (#208): asked once on first launch (Accept or Not now), again when the version
// goes up; online play needs Accept, and the website's pages the same text and version as the app's.
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error: the project has no @types/node; Vitest runs on Node.
import { readFileSync } from 'node:fs';
import { acceptedFor, acceptTerms, answeredFor, answeredTerms, declineTerms, hasAcceptedTerms, LEGAL_MD, LEGAL_VERSION, offerTerms, requireTerms } from '../src/ui/legal';
import { legalHtml, legalVersionOf } from '../src/ui/legalText';
import { settings } from '../src/ui/settings';
// @ts-expect-error: a Node script (tools/), not typechecked.
import { sitePages } from '../tools/legal-site.mjs';

const host = {} as HTMLElement;
afterEach(() => {
  settings.legal = null;
});

describe('the Privacy note and Terms of use (#208)', () => {
  /** A stand-in for the sheet: counts the times it's shown and answers as told (it records, as the sheet does). */
  const sheet = (answer: 'accept' | 'later' | null) => {
    const seen: boolean[] = [];
    const show = (_h: HTMLElement, onAnswer: (ok: boolean) => void, online = false) => {
      seen.push(online);
      if (answer === 'accept') acceptTerms(1234);
      if (answer === 'later') declineTerms(1234);
      if (answer) onAnswer(answer === 'accept');
    };
    return { seen, show };
  };

  it('first launch asks, and Accept stores { version, at }: never asked again, online or at launch', async () => {
    const s1 = sheet('accept');
    await offerTerms(host, s1.show);
    expect(s1.seen).toEqual([false]);
    expect(settings.legal).toEqual({ version: LEGAL_VERSION, at: 1234 });
    expect(hasAcceptedTerms()).toBe(true);
    const s2 = sheet(null);
    await offerTerms(host, s2.show);
    expect(await requireTerms(host, s2.show)).toBe(true);
    expect(s2.seen).toEqual([]);
  });

  it('Not now: offline play goes on, the launch sheet stops asking, and online play is blocked until Accept', async () => {
    const s1 = sheet('later');
    await offerTerms(host, s1.show); // resolves: offline play needs nothing
    expect(settings.legal).toEqual({ version: LEGAL_VERSION, at: 1234, declined: true });
    expect(hasAcceptedTerms()).toBe(false);
    expect(answeredTerms()).toBe(true);
    // The next launch doesn't nag.
    const s2 = sheet(null);
    await offerTerms(host, s2.show);
    expect(s2.seen).toEqual([]);
    // Online asks (the online sheet), and Not now there keeps it blocked.
    const s3 = sheet('later');
    expect(await requireTerms(host, s3.show)).toBe(false);
    expect(s3.seen).toEqual([true]);
    expect(hasAcceptedTerms()).toBe(false);
    // Accept there lets it connect, and it stays accepted.
    const s4 = sheet('accept');
    expect(await requireTerms(host, s4.show)).toBe(true);
    expect(hasAcceptedTerms()).toBe(true);
    const s5 = sheet(null);
    expect(await requireTerms(host, s5.show)).toBe(true);
    expect(s5.seen).toEqual([]);
  });

  it('asks again when the version goes up, whether the old one was accepted or declined', async () => {
    expect(acceptedFor({ version: LEGAL_VERSION, at: 1 })).toBe(true);
    expect(acceptedFor({ version: LEGAL_VERSION, at: 1 }, LEGAL_VERSION + 1)).toBe(false);
    expect(acceptedFor({ version: LEGAL_VERSION, at: 1, declined: true })).toBe(false);
    expect(answeredFor({ version: LEGAL_VERSION, at: 1, declined: true })).toBe(true);
    expect(answeredFor({ version: LEGAL_VERSION, at: 1 }, LEGAL_VERSION + 1)).toBe(false);
    expect(acceptedFor(null)).toBe(false);
    for (const old of [{ version: LEGAL_VERSION - 1, at: 1 }, { version: LEGAL_VERSION - 1, at: 1, declined: true }]) {
      settings.legal = old;
      const s1 = sheet('accept');
      await offerTerms(host, s1.show);
      expect(s1.seen).toEqual([false]);
    }
  });

  it('hasAcceptedTerms follows what is stored', () => {
    expect(hasAcceptedTerms()).toBe(false);
    acceptTerms();
    expect(hasAcceptedTerms()).toBe(true);
    expect(settings.legal!.version).toBe(LEGAL_VERSION);
    expect(Math.abs(settings.legal!.at - Date.now())).toBeLessThan(5000);
  });

  it('one document, Privacy & Terms: the app, the text and the website carry the same version and text', () => {
    expect(legalVersionOf(LEGAL_MD)).toBe(LEGAL_VERSION);
    // The first released text is version 1; bump at most once per release (see LEGAL_VERSION).
    expect(LEGAL_VERSION).toBe(1);
    // Terms first, then Privacy, each a part with its anchor (the old pages redirect there).
    expect(LEGAL_MD.indexOf('## Terms of use')).toBeGreaterThan(0);
    expect(LEGAL_MD.indexOf('## Privacy note')).toBeGreaterThan(LEGAL_MD.indexOf('## Terms of use'));
    const pages = sitePages();
    expect(pages.map((p: { path: string }) => p.path)).toEqual(['docs/legal.html', 'docs/privacy.html', 'docs/terms.html']);
    for (const page of pages) {
      const onDisk = (readFileSync(new URL(`../${page.path}`, import.meta.url), 'utf8') as string).replace(/\r\n/g, '\n');
      expect(onDisk, `${page.path} is out of date: run node tools/legal-site.mjs`).toBe(page.html);
    }
    expect(pages[0].html).toContain(`<meta name="legal-version" content="${LEGAL_VERSION}">`);
    expect(pages[0].html).toContain('<h2 id="terms-of-use">');
    expect(pages[0].html).toContain('<h2 id="privacy-note">');
    expect(pages[1].html).toContain('url=legal.html#privacy-note');
    expect(pages[2].html).toContain('url=legal.html#terms-of-use');
    // The owner's details are filled in, and no placeholder is left.
    const all = LEGAL_MD;
    for (const p of ['JuteBags ("we")', 'shaurya.sharthak.work@gmail.com', 'the laws of India']) expect(all).toContain(p);
    expect(all).not.toMatch(/\[[A-Z ]+\]/);
  });

  it('promises nothing about ads or tracking (the game may add them later, with a new version to accept)', () => {
    const sheetSource = readFileSync(new URL('../src/ui/legal.ts', import.meta.url), 'utf8') as string;
    for (const text of [LEGAL_MD, ...sitePages().map((p: { html: string }) => p.html), sheetSource]) expect(text).not.toMatch(/no ads|no tracking|no advertising|no analytics/i);
    expect(LEGAL_MD).toContain('**Ads and analytics:**');
    expect(LEGAL_MD).toContain("**We don't sell it.**");
  });

  it('renders the texts: headings, lists, bold and links', () => {
    const html = legalHtml('# Title\n\nVersion 1 · date\n\n## Part\n- **One** thing\n- Two: https://example.com/x, and more.\n\nA line\nwrapped.', 3);
    expect(html).not.toContain('Title');
    expect(html).toContain('<h3 id="part">Part</h3>');
    expect(legalHtml('## Terms of use\n### 1. The game', 2)).toBe('<h2 id="terms-of-use">Terms of use</h2>\n<h3>1. The game</h3>');
    expect(html).toContain('<li><b>One</b> thing</li>');
    expect(html).toContain('<a href="https://example.com/x" target="_blank" rel="noopener">https://example.com/x</a>, and more.');
    expect(html).toContain('<p>A line wrapped.</p>');
    expect(legalHtml('<script>', 2)).toBe('<p>&lt;script&gt;</p>');
    expect(legalHtml('write to a.b@example.com.', 2)).toBe('<p>write to <a href="mailto:a.b@example.com">a.b@example.com</a>.</p>');
  });
});
