// Gold (src/ui/rewards.ts) and spending it in the Store (src/ui/skins.ts).
import { describe, expect, it } from 'vitest';
import { ACHIEVEMENTS, goldFor, newAchievements, nextStreak, total, type GameFacts } from '../src/ui/rewards';
import { emptyStats, type Stats } from '../src/ui/store';
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
  const stats = emptyStats();
  const game: GameFacts = { mode: 'pvc', place: 1, lost: 0, level: 'normal', layout: '2p' };
  const ids = (s: Stats, g: GameFacts | null, done: string[] = []) => newAchievements(s, g, done).map((a) => a.id);
  const wins = (lv: Partial<Stats['levelWins']>) => ({ ...stats.levelWins, ...lv });

  it('gives a first win, and a flawless win when no token was lost', () => {
    expect(ids({ ...stats, wins: 1, played: 1, levelWins: wins({ normal: 1 }) }, game)).toEqual(['win-easy', 'win-normal', 'first-win', 'flawless']);
    expect(ids({ ...stats, wins: 1 }, { ...game, lost: 2 })).toEqual(['first-win']);
  });
  it('never gives the same achievement twice', () => {
    expect(ids({ ...stats, wins: 1 }, game, ['first-win', 'flawless'])).toEqual([]);
  });
  it('counts totals', () => {
    expect(ids({ ...stats, wins: 10, kills: 60, sixes: 100, bestStreak: 3, friends: 5 }, { ...game, lost: 1 })).toEqual(['wins-10', 'streak-3', 'kills-50', 'sixes-100', 'friends-5', 'first-win'].sort((x, y) => order(x) - order(y)));
  });
  it('climbs the ladder: a win at one level counts for every level below it', () => {
    expect(ids({ ...stats, levelWins: wins({ easy: 1 }) }, null)).toEqual(['win-easy']);
    expect(ids({ ...stats, levelWins: wins({ hard: 1 }) }, null)).toEqual(['win-easy', 'win-normal', 'hard-win']);
    expect(ids({ ...stats, levelWins: wins({ extreme: 1 }) }, null, ['win-easy'])).toEqual(['win-normal', 'hard-win', 'win-extreme']);
  });
  it('pays the Extreme streaks at 3, 5 and 7 wins in a row', () => {
    expect(ids({ ...stats, xBestStreak: 2 }, null)).toEqual([]);
    expect(ids({ ...stats, xBestStreak: 3 }, null)).toEqual(['x-streak-3']);
    expect(ids({ ...stats, xBestStreak: 7 }, null, ['x-streak-3'])).toEqual(['x-streak-5', 'x-streak-7']);
  });
  it('tours every layout against Extreme, and knows Purist and Against all odds', () => {
    const tour = ACHIEVEMENTS.find((a) => a.id === 'x-tour')!;
    expect(tour.progress!({ ...stats, xModes: ['2p', '4p'] })).toEqual([2, 5]);
    expect(ids({ ...stats, xModes: ['2p', '3p', '4p', '2h-opposite', '2h-side'] }, null)).toEqual(['x-tour']);
    const x = { ...game, level: 'extreme' as const, lost: 1 };
    expect(ids(stats, { ...x, singles: true })).toEqual(['x-purist']);
    expect(ids(stats, { ...x, layout: '4p' })).toEqual(['x-odds']);
    expect(ids(stats, { ...x, layout: '4p', place: 2 })).toEqual([]);
  });
  it('rewards check-in runs of 7 and 30 days', () => {
    expect(ids({ ...stats, checkinBest: 7 }, null)).toEqual(['checkin-7']);
    expect(ids({ ...stats, checkinBest: 30 }, null, ['checkin-7'])).toEqual(['checkin-30']);
  });
  it('shows progress toward the totals, and hides a streak nobody started', () => {
    expect(ACHIEVEMENTS.find((a) => a.id === 'kills-50')!.progress!({ ...stats, kills: 12 })).toEqual([12, 50]);
    const hat = ACHIEVEMENTS.find((a) => a.id === 'x-streak-3')!;
    expect(hat.quiet && hat.progress!(stats)).toEqual([0, 3]);
  });
  it('names the next Extreme streak achievement while a streak is live', () => {
    expect(nextStreak(stats, [])).toBeNull();
    expect(nextStreak({ ...stats, xStreak: 2 }, [])).toEqual({ name: 'Hat-trick', gold: 1500, more: 1 });
    expect(nextStreak({ ...stats, xStreak: 3 }, ['x-streak-3'])).toEqual({ name: 'Unstoppable', gold: 3000, more: 2 });
    expect(nextStreak({ ...stats, xStreak: 8 }, ['x-streak-3', 'x-streak-5', 'x-streak-7'])).toBeNull();
  });
  it('keeps the ids stored by earlier versions', () => {
    for (const id of ['first-win', 'wins-10', 'streak-3', 'kills-50', 'sixes-100', 'flawless', 'hard-win', 'friends-5']) expect(ACHIEVEMENTS.some((a) => a.id === id)).toBe(true);
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(ACHIEVEMENTS.length);
  });
});

const order = (id: string) => ACHIEVEMENTS.findIndex((a) => a.id === id);
