// Gold (src/ui/rewards.ts) and spending it in the Store (src/ui/skins.ts).
import { describe, expect, it } from 'vitest';
import { goldFor, total } from '../src/ui/rewards';
import { settings } from '../src/ui/settings';
import { SKINS, buy, earn, isUnlocked, nextGoal } from '../src/ui/skins';

describe('gold for a game', () => {
  it('pays vs Computer for playing, the place, kills and tokens home', () => {
    expect(goldFor({ mode: 'pvc', place: 1, kills: 3, home: 4 })).toEqual([
      { label: 'Game played', gold: 20 },
      { label: 'Win', gold: 60 },
      { label: '3 kills', gold: 15 },
      { label: '4 tokens home', gold: 20 },
    ]);
    expect(total(goldFor({ mode: 'pvc', place: 4, kills: 0, home: 0 }))).toBe(20);
    expect(total(goldFor({ mode: 'pvc', place: 2, kills: 1, home: 1 }))).toBe(60);
  });
  it('pays a flat amount with friends', () => {
    expect(total(goldFor({ mode: 'pvp', place: 3, kills: 9, home: 4 }))).toBe(15);
  });
});

describe('spending gold', () => {
  it('buys a skin only with enough gold, once, and then it is unlocked', () => {
    settings.gold = 0;
    settings.owned = [];
    const bone = SKINS.find((s) => s.shelf === 'dice' && s.id === 'bone')!;
    expect(nextGoal()).toBe(bone);
    expect(buy(bone)).toBe(false);
    earn(350);
    expect(buy(bone)).toBe(true);
    expect(settings.gold).toBe(50);
    expect(isUnlocked(bone, false)).toBe(true);
    expect(buy(bone)).toBe(false);
    expect(nextGoal()).not.toBe(bone);
    settings.gold = 0;
    settings.owned = [];
  });
});
