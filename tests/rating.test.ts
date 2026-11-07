// Ranked PvP: tiers, rating changes (src/net/rating.ts) and the matchmaker's grouping (server/src/matchmaker.ts).
import { describe, expect, it } from 'vitest';
import { BOT_FILL_MS, K, K_NEW, START_RATING, botLevelFor, matchWindow, rate, tierOf } from '../src/net/rating';
import { findMatches, type Waiting } from '../server/src/queue';

describe('tiers', () => {
  it('names tiers, divisions and points', () => {
    expect(tierOf(START_RATING)).toMatchObject({ label: 'Silver III', points: 0 });
    expect(tierOf(1062)).toMatchObject({ label: 'Silver III', points: 62 });
    expect(tierOf(1299)).toMatchObject({ label: 'Silver I', points: 99 });
    expect(tierOf(1300)).toMatchObject({ label: 'Gold III', points: 0 });
    expect(tierOf(1755)).toMatchObject({ label: 'Platinum II', points: 55 });
    expect(tierOf(2210)).toMatchObject({ label: 'Diamond', division: '', points: 310 });
    expect(tierOf(910)).toMatchObject({ label: 'Bronze I', points: 10 });
    expect(tierOf(400)).toMatchObject({ label: 'Bronze III', points: 0 });
  });
});

describe('rating changes', () => {
  const side = (ratings: number[], place: number, games = 20) => ({ ratings, games: ratings.map(() => games), place });

  it('1v1: equal players move by K/2, and a win is worth more against someone stronger', () => {
    expect(rate([side([1000], 0), side([1000], 1)])).toEqual([[K / 2], [-K / 2]]);
    const upset = rate([side([1000], 0), side([1400], 1)])[0]![0];
    const expected = rate([side([1400], 0), side([1000], 1)])[0]![0];
    expect(upset!).toBeGreaterThan(expected!);
  });

  it('new players move faster (K_NEW for their first games)', () => {
    expect(rate([side([1000], 0, 0), side([1000], 1, 0)])).toEqual([[K_NEW / 2], [-K_NEW / 2]]);
  });

  it('2v2: both partners get the same change, from the teams\' averages', () => {
    const d = rate([side([1100, 900], 0), side([1000, 1000], 1)]);
    expect(d[0]![0]).toBe(d[0]![1]);
    expect(d[0]![0]).toBe(K / 2);
  });

  it('1v1v1v1: first gains most, last loses most, and the total is about zero', () => {
    const d = rate([0, 1, 2, 3].map((p) => side([1000], p))).map((x) => x[0]!);
    expect(d[0]).toBeGreaterThan(d[1]!);
    expect(d[1]).toBeGreaterThan(d[2]!);
    expect(d[2]).toBeGreaterThan(d[3]!);
    expect(Math.abs(d.reduce((a, b) => a + b, 0))).toBeLessThanOrEqual(2);
  });

  it('bot levels follow the rating', () => {
    expect([botLevelFor(900), botLevelFor(1000), botLevelFor(1299), botLevelFor(1300)]).toEqual(['easy', 'normal', 'normal', 'hard']);
  });
});

describe('matchmaking', () => {
  const w = (id: string, rating: number, since = 0): Waiting => ({ id, name: id, rating, since });

  it('matches close ratings at once, and waits for far ones until the window grows', () => {
    expect(findMatches([w('a', 1000), w('b', 1080)], '1v1', 0)).toHaveLength(1);
    expect(findMatches([w('a', 1000), w('b', 1300)], '1v1', 0)).toHaveLength(0);
    // 300 apart: the window reaches 300 after 20 s.
    expect(matchWindow(20_000)).toBe(300);
    expect(findMatches([w('a', 1000), w('b', 1300)], '1v1', 20_000)).toHaveLength(1);
  });

  it('pairs the closest ratings first', () => {
    const [m] = findMatches([w('a', 1000), w('far', 1090), w('near', 1010)], '1v1', 0);
    expect(m!.slots.map((x) => x?.id)).toEqual(['a', 'near']);
  });

  it('after a minute, ranked bots at your rating fill the empty places', () => {
    expect(findMatches([w('a', 1200)], 'ffa', BOT_FILL_MS - 1)).toHaveLength(0);
    const [m] = findMatches([w('a', 1200), w('b', 1210)], 'ffa', BOT_FILL_MS);
    expect(m!.slots.filter((x) => x === null)).toHaveLength(2);
    expect(m!.botRating).toBe(1205);
  });

  it('2v2: the best and the weakest are partners (slots A, B, A, B)', () => {
    const [m] = findMatches([w('d', 1090), w('a', 1000), w('c', 1060), w('b', 1030)], '2v2', 0);
    expect(m!.slots.map((x) => x!.id)).toEqual(['d', 'c', 'a', 'b']);
  });

  it('keeps a full queue apart into several games', () => {
    const q = [w('a', 1000), w('b', 1010), w('c', 1500), w('d', 1510)];
    expect(findMatches(q, '1v1', 0).map((m) => m.slots.map((x) => x!.id).sort().join(''))).toEqual(['ab', 'cd']);
  });
});
