// Copy that works in the Android app too (#237, src/ui/clipboard.ts): the web clipboard first, then the Capacitor plugin.
import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ on: false, written: [] as string[], fail: false }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native.on } }));
vi.mock('@capacitor/clipboard', () => ({
  Clipboard: {
    write: async ({ string }: { string: string }) => {
      if (native.fail) throw new Error('no clipboard');
      native.written.push(string);
    },
  },
}));

import { copyText } from '../src/ui/clipboard';

const setClipboard = (writeText?: (s: string) => Promise<void>) =>
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: writeText ? { writeText } : undefined }, configurable: true });

describe('copyText (#237)', () => {
  afterEach(() => {
    native.on = false;
    native.fail = false;
    native.written = [];
  });

  it('uses the web clipboard when it works', async () => {
    const got: string[] = [];
    setClipboard(async (s) => void got.push(s));
    expect(await copyText('ABCDE')).toBe(true);
    expect(got).toEqual(['ABCDE']);
    expect(native.written).toEqual([]);
  });

  it('in the app, falls back to the Capacitor clipboard when the web one fails or is missing', async () => {
    native.on = true;
    setClipboard(async () => {
      throw new Error('NotAllowedError');
    });
    expect(await copyText('K7Q2MZ')).toBe(true);
    setClipboard(undefined);
    expect(await copyText('ROOM1')).toBe(true);
    expect(native.written).toEqual(['K7Q2MZ', 'ROOM1']);
  });

  it('says false, never throws, when nothing could copy', async () => {
    setClipboard(async () => {
      throw new Error('denied');
    });
    expect(await copyText('x')).toBe(false); // the web, no app clipboard
    native.on = true;
    native.fail = true;
    expect(await copyText('x')).toBe(false);
  });
});
