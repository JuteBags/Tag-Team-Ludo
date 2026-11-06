// The Privacy note and Terms of use (#208): accepted once on first launch, asked again when the version goes up,
// checked before online play, and the website's pages the same text and version as the app's.
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error: the project has no @types/node; Vitest runs on Node.
import { readFileSync } from 'node:fs';
import { acceptedFor, acceptTerms, hasAcceptedTerms, LEGAL_MD, LEGAL_VERSION, requireTerms } from '../src/ui/legal';
import { legalHtml, legalVersionOf } from '../src/ui/legalText';
import { settings } from '../src/ui/settings';
// @ts-expect-error: a Node script (tools/), not typechecked.
import { sitePages } from '../tools/legal-site.mjs';

const host = {} as HTMLElement;
afterEach(() => {
  settings.legal = null;
});

describe('the Privacy note and Terms of use (#208)', () => {
  it('first launch shows the sheet, and Accept stores { version, at }', async () => {
    settings.legal = null;
    expect(hasAcceptedTerms()).toBe(false);
    let shown = 0;
    let accept = () => {};
    const done = requireTerms(host, (_h, onAccept) => {
      shown++;
      accept = () => {
        acceptTerms(1234);
        onAccept();
      };
    });
    expect(shown).toBe(1);
    accept();
    await done;
    expect(settings.legal).toEqual({ version: LEGAL_VERSION, at: 1234 });
    expect(hasAcceptedTerms()).toBe(true);
    // Accepted: the next launch (and online play) doesn't ask.
    await requireTerms(host, () => {
      shown++;
    });
    expect(shown).toBe(1);
  });

  it('asks again when the version goes up, and for an older acceptance', () => {
    expect(acceptedFor({ version: LEGAL_VERSION })).toBe(true);
    expect(acceptedFor({ version: LEGAL_VERSION }, LEGAL_VERSION + 1)).toBe(false);
    expect(acceptedFor(null)).toBe(false);
    settings.legal = { version: LEGAL_VERSION - 1, at: 1 };
    expect(hasAcceptedTerms()).toBe(false);
    let shown = false;
    void requireTerms(host, () => {
      shown = true;
    });
    expect(shown).toBe(true);
  });

  it('hasAcceptedTerms follows what is stored', () => {
    expect(hasAcceptedTerms()).toBe(false);
    acceptTerms();
    expect(hasAcceptedTerms()).toBe(true);
    expect(settings.legal!.version).toBe(LEGAL_VERSION);
    expect(Math.abs(settings.legal!.at - Date.now())).toBeLessThan(5000);
  });

  it('the app, the texts and the website pages carry the same version and text', () => {
    for (const md of Object.values(LEGAL_MD)) expect(legalVersionOf(md)).toBe(LEGAL_VERSION);
    for (const page of sitePages()) {
      const onDisk = (readFileSync(new URL(`../${page.path}`, import.meta.url), 'utf8') as string).replace(/\r\n/g, '\n');
      expect(onDisk, `${page.path} is out of date: run node tools/legal-site.mjs`).toBe(page.html);
      expect(onDisk).toContain(`<meta name="legal-version" content="${LEGAL_VERSION}">`);
    }
    // The owner's details are filled in, and no placeholder is left.
    const all = Object.values(LEGAL_MD).join('\n');
    for (const p of ['JuteBags ("we")', 'shaurya.sharthak.work@gmail.com', 'the laws of India']) expect(all).toContain(p);
    expect(all).not.toMatch(/\[[A-Z ]+\]/);
  });

  it('promises nothing about ads or tracking (the game may add them later, with a new version to accept)', () => {
    const sheetSource = readFileSync(new URL('../src/ui/legal.ts', import.meta.url), 'utf8') as string;
    for (const text of [...Object.values(LEGAL_MD), ...sitePages().map((p: { html: string }) => p.html), sheetSource]) expect(text).not.toMatch(/no ads|no tracking|no advertising|no analytics/i);
    expect(LEGAL_MD.privacy).toContain('**Ads and analytics:**');
  });

  it('renders the texts: headings, lists, bold and links', () => {
    const html = legalHtml('# Title\n\nVersion 1 · date\n\n## Part\n- **One** thing\n- Two: https://example.com/x, and more.\n\nA line\nwrapped.', 3);
    expect(html).not.toContain('Title');
    expect(html).toContain('<h3>Part</h3>');
    expect(html).toContain('<li><b>One</b> thing</li>');
    expect(html).toContain('<a href="https://example.com/x" target="_blank" rel="noopener">https://example.com/x</a>, and more.');
    expect(html).toContain('<p>A line wrapped.</p>');
    expect(legalHtml('<script>', 2)).toBe('<p>&lt;script&gt;</p>');
    expect(legalHtml('write to a.b@example.com.', 2)).toBe('<p>write to <a href="mailto:a.b@example.com">a.b@example.com</a>.</p>');
  });
});
