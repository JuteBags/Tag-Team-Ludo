// Room and friend links (#238): the links, reading them back (fragment, or the app's query), the Android intent, and
// the app's intent filter.
import { describe, expect, it } from 'vitest';
import { friendLinkUrl, intentUrl, linkAction, roomLinkUrl } from '../src/ui/replay';

const SITE = 'https://jutebags.github.io/Tag-Team-Ludo/';

describe('room and friend links (#238)', () => {
  it('makes plain https links to the game', () => {
    expect(roomLinkUrl('ABCDE', SITE)).toBe('https://jutebags.github.io/Tag-Team-Ludo/play/#join=ABCDE');
    expect(friendLinkUrl('K7Q2MZ', SITE)).toBe('https://jutebags.github.io/Tag-Team-Ludo/play/#friend=K7Q2MZ');
  });

  it('reads them back from the fragment, or from the query the app is opened with; anything else is no link', () => {
    expect(linkAction('#join=ABCDE')).toEqual({ join: 'ABCDE' });
    expect(linkAction('#join=abcde')).toEqual({ join: 'ABCDE' });
    expect(linkAction('#friend=k7q2mz')).toEqual({ friend: 'K7Q2MZ' });
    expect(linkAction('', '?join=ABCDE')).toEqual({ join: 'ABCDE' });
    expect(linkAction('', '?friend=K7Q2MZ')).toEqual({ friend: 'K7Q2MZ' });
    for (const bad of ['#join=ABCD', '#join=ABCDEF', '#join=AB<DE', '#friend=K7Q2M', '#game=xyz', '#g=ABCDEFGHJKLM', '#bench', ''])
      expect(linkAction(bad)).toBeNull();
    expect(linkAction('', '?join=<script>')).toBeNull();
  });

  it('the Android intent opens the app on the same link (the code in the query), and falls back to the web game', () => {
    const room = intentUrl({ join: 'ABCDE' }, SITE);
    expect(room).toBe(`intent://jutebags.github.io/Tag-Team-Ludo/play/?join=ABCDE#Intent;scheme=https;package=com.jutebags.ludo;S.browser_fallback_url=${encodeURIComponent(roomLinkUrl('ABCDE', SITE))};end`);
    const friend = intentUrl({ friend: 'K7Q2MZ' }, SITE);
    expect(friend).toContain('/play/?friend=K7Q2MZ#Intent;scheme=https;package=com.jutebags.ludo;');
    // What the app gets (the intent's data URI) reads back to the same action.
    const data = new URL(`https://${friend.slice('intent://'.length, friend.indexOf('#Intent'))}`);
    expect(linkAction(data.hash, data.search)).toEqual({ friend: 'K7Q2MZ' });
  });

  it('the app’s intent filter takes the game’s https links (VIEW, BROWSABLE, the host and the path)', async () => {
    // @ts-expect-error: the project has no @types/node; Vitest runs on Node.
    const { readFileSync } = await import('node:fs');
    const xml: string = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
    const filters = [...xml.matchAll(/<intent-filter[^>]*>([\s\S]*?)<\/intent-filter>/g)].map((m) => m[1]!);
    const links = filters.find((f) => f.includes('android.intent.action.VIEW'));
    expect(links).toBeDefined();
    expect(links).toContain('android.intent.category.BROWSABLE');
    expect(links).toContain('android.intent.category.DEFAULT');
    expect(links).toMatch(/android:scheme="https"/);
    expect(links).toMatch(/android:host="jutebags\.github\.io"/);
    expect(links).toMatch(/android:pathPrefix="\/Tag-Team-Ludo\/play"/);
    // The activity takes links while running (one task: appUrlOpen, not a second copy).
    expect(xml).toMatch(/android:launchMode="singleTask"/);
  });
});
