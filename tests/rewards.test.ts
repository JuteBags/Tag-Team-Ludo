// Gold (src/ui/rewards.ts) and spending it in the Store (src/ui/skins.ts).
import { describe, expect, it } from 'vitest';
import { ACHIEVEMENTS, goldFor, newAchievements, total } from '../src/ui/rewards';
import { EMPTY_STATS } from '../src/ui/store';
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
  it('pays more against harder bots', () => {
    expect(total(goldFor({ mode: 'pvc', place: 1, kills: 3, home: 4, level: 'normal' }))).toBe(115);
    expect(goldFor({ mode: 'pvc', place: 1, kills: 3, home: 4, level: 'hard' }).at(-1)).toEqual({ label: 'Hard bots bonus', gold: 58 });
    expect(total(goldFor({ mode: 'pvc', place: 1, kills: 3, home: 4, level: 'extreme' }))).toBe(115 + 173);
    expect(total(goldFor({ mode: 'pvp', place: 1, kills: 3, home: 4, level: 'extreme' }))).toBe(15);
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

describe('achievements', () => {
  const stats = { ...EMPTY_STATS };
  const game = { mode: 'pvc' as const, place: 1, lost: 0, hard: false };
  it('gives a first win, and a flawless win when no token was lost', () => {
    const ids = newAchievements({ ...stats, wins: 1, played: 1 }, game, []).map((a) => a.id);
    expect(ids).toEqual(['first-win', 'flawless']);
    expect(newAchievements({ ...stats, wins: 1 }, { ...game, lost: 2 }, []).map((a) => a.id)).toEqual(['first-win']);
  });
  it('never gives the same achievement twice', () => {
    expect(newAchievements({ ...stats, wins: 1 }, game, ['first-win', 'flawless'])).toEqual([]);
  });
  it('counts totals and wins against Hard bots', () => {
    const ids = newAchievements({ ...stats, wins: 10, kills: 60, sixes: 100, bestStreak: 3, friends: 5 }, { ...game, lost: 1, hard: true }, []).map((a) => a.id);
    expect(ids).toEqual(['first-win', 'wins-10', 'streak-3', 'kills-50', 'sixes-100', 'hard-win', 'friends-5']);
  });
  it('shows progress toward the totals', () => {
    expect(ACHIEVEMENTS.find((a) => a.id === 'kills-50')!.progress!({ ...stats, kills: 12 })).toEqual([12, 50]);
  });
});
