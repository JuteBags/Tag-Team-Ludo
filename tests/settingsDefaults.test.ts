// The settings' defaults (src/ui/settings.ts): new players start with doubles off (#185); a saved choice is kept.
import { afterEach, describe, expect, it, vi } from 'vitest';

const fakeStorage = (saved: Record<string, string>) => ({
  getItem: (k: string) => saved[k] ?? null,
  setItem: (k: string, v: string) => void (saved[k] = v),
  removeItem: (k: string) => void delete saved[k],
});

const fresh = async (saved: Record<string, string>) => {
  vi.resetModules();
  vi.stubGlobal('localStorage', fakeStorage(saved));
  return (await import('../src/ui/settings')).settings;
};

afterEach(() => vi.unstubAllGlobals());

describe('settings defaults', () => {
  it('a new player starts with doubles off', async () => {
    expect((await fresh({})).doubles).toBe(false);
  });

  it('a player who saved doubles on keeps them on', async () => {
    expect((await fresh({ 'ludo-settings': JSON.stringify({ doubles: true }) })).doubles).toBe(true);
  });

  it('settings saved before doubles had a choice (no doubles key) start with doubles off', async () => {
    expect((await fresh({ 'ludo-settings': JSON.stringify({ theme: 'wood' }) })).doubles).toBe(false);
  });
});
