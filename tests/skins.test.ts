// The Store's catalogue (src/ui/skins.ts): every shelf has a free default, locked skins stay locked in
// release builds, and every skin has its art.
import { describe, expect, it } from 'vitest';
import { COLORS } from '../src/engine';
import { pawnArt } from '../src/ui/art';
import { THROWER_ART, dieMarkup } from '../src/ui/dice';
import { settings } from '../src/ui/settings';
import { SHELVES, SKINS, buy, equip, equipped, isUnlocked, lockLabel, shelfSkins, skinUnlockedBy } from '../src/ui/skins';
import { THEMES } from '../src/ui/themes';
// @ts-expect-error: the project has no @types/node; Vitest runs on Node.
import { readFileSync } from 'node:fs';

const css: string = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');

describe('the Store catalogue', () => {
  it('has one entry per skin on each shelf, and a free default first', () => {
    for (const { id } of SHELVES) {
      const skins = shelfSkins(id);
      expect(new Set(skins.map((s) => s.id)).size, id).toBe(skins.length);
      expect(skins[0]!.unlock.kind, id).toBe('free');
    }
  });

  it('keeps locked skins locked in a release build, and opens all of them in a test build', () => {
    const locked = SKINS.filter((s) => s.unlock.kind !== 'free');
    expect(locked.length).toBeGreaterThan(0);
    for (const s of locked) {
      expect(isUnlocked(s, false)).toBe(false);
      expect(isUnlocked(s, true)).toBe(true);
      expect(lockLabel(s)).not.toBe('');
    }
  });

  it("won't use a locked skin in a release build, and falls back to the shelf default", () => {
    const skull = SKINS.find((s) => s.shelf === 'pawn' && s.id === 'skull')!;
    expect(equip(skull, false)).toBe(false);
    settings.equipped = { ...settings.equipped, pawn: 'skull' };
    expect(equipped('pawn', false).id).toBe('classic');
    expect(equipped('pawn', true).id).toBe('skull');
    settings.equipped = { ...settings.equipped, pawn: 'classic' };
  });

  it('has art for every skin', () => {
    const classic = pawnArt('blue', 'classic');
    for (const s of shelfSkins('pawn')) {
      for (const c of COLORS) expect(pawnArt(c, s.id)).toContain('class="pawn-art"');
      if (s.id !== 'classic') expect(pawnArt('blue', s.id), s.id).not.toBe(classic);
    }
    for (const s of shelfSkins('dice')) {
      expect(dieMarkup(6, 40, undefined, undefined, 'top', s.id)).toContain(`dk-${s.id}`);
      if (s.id !== 'classic') expect(css, s.id).toContain(`.dk-${s.id} .f{`);
    }
    for (const s of shelfSkins('thrower')) if (s.id !== 'toss') expect(THROWER_ART[s.id], s.id).toBeTruthy();
    for (const s of shelfSkins('board')) {
      expect(THEMES.some((t) => t.id === s.id), s.id).toBe(true);
      if (s.id !== 'classic') expect(css, s.id).toContain(`[data-theme=${s.id}]{`);
    }
  });

  it('opens the streak skins with their achievements, and never sells them', () => {
    const inferno = SKINS.find((x) => x.shelf === 'dice' && x.id === 'inferno')!;
    const crowned = SKINS.find((x) => x.shelf === 'pawn' && x.id === 'crowned')!;
    expect(lockLabel(inferno)).toBe('Win 5 in a row vs Extreme');
    expect(lockLabel(crowned)).toBe('Win 7 in a row vs Extreme');
    expect(skinUnlockedBy('x-streak-5')).toBe(inferno);
    expect(skinUnlockedBy('x-streak-7')).toBe(crowned);
    expect(skinUnlockedBy('first-win')).toBeUndefined();
    const before = settings.achieved;
    settings.gold = 100_000;
    settings.achieved = [];
    expect(isUnlocked(inferno, false)).toBe(false);
    expect(buy(inferno)).toBe(false);
    settings.achieved = ['x-streak-5'];
    expect(isUnlocked(inferno, false)).toBe(true);
    expect(isUnlocked(crowned, false)).toBe(false);
    expect(equip(inferno, false)).toBe(true);
    settings.achieved = ['x-streak-5', 'x-streak-7'];
    expect(isUnlocked(crowned, false)).toBe(true);
    expect(settings.gold).toBe(100_000);
    settings.achieved = before;
    settings.gold = 0;
    settings.equipped = { ...settings.equipped, dice: 'classic' };
  });
});

