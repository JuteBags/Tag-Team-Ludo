// Ranked PvP: tiers, rating changes (src/net/rating.ts) and the matchmaker's grouping (server/src/matchmaker.ts).
import { describe, expect, it } from 'vitest';
import { BOT_FILL_MS, BOTS_BELOW, K, K_NEW, LOWER_LEAGUE_MS, START_RATING, botLevelFor, botsAllowed, leagueOf, matchWindow, rate, tierOf } from '../src/net/rating';
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

describe('Ranked, the owner’s rules (#216)', () => {
  const w = (id: string, rating: number, since = 0): Waiting => ({ id, name: id, rating, since });
  const ids = (ms: ReturnType<typeof findMatches>) => ms.map((m) => m.slots.map((s) => s?.id ?? 'bot'));

  it('leagues and the Gold III line', () => {
    expect([999, 1000, 1299, 1300, 1599, 1600, 1899, 1900].map(leagueOf)).toEqual([0, 1, 1, 2, 2, 3, 3, 4]);
    expect(tierOf(1399).label).toBe('Gold III');
    expect(tierOf(BOTS_BELOW).label).toBe('Gold II');
    expect(botsAllowed([{ rating: 1399 }, { rating: 900 }])).toBe(true);
    expect(botsAllowed([{ rating: 1399 }, { rating: 1400 }])).toBe(false);
  });

  it('matches two people by rating in the same league at once', () => {
    expect(ids(findMatches([w('a', 1100), w('b', 1150)], '1v1', 0))).toEqual([['a', 'b']]);
  });

  it('crosses into the league just below only after LOWER_LEAGUE_MS, and never two leagues', () => {
    // Gold 1320 and Silver 1250: within the window, but different leagues.
    expect(findMatches([w('g', 1320), w('s', 1250)], '1v1', LOWER_LEAGUE_MS - 1)).toHaveLength(0);
    expect(ids(findMatches([w('g', 1320), w('s', 1250)], '1v1', LOWER_LEAGUE_MS))).toEqual([['g', 's']]);
    // The higher one must have waited (the search widens downwards, not up).
    expect(findMatches([w('g', 1320, LOWER_LEAGUE_MS), w('s', 1250, 0)], '1v1', LOWER_LEAGUE_MS)).toHaveLength(0);
    // Bronze and Gold: two leagues apart, never, however long (a lone wait ends in bots, both under Gold II).
    const far = findMatches([w('b', 990), w('g', 1310)], '1v1', BOT_FILL_MS - 1);
    expect(far).toHaveLength(0);
  });

  it('up to Gold III, bots fill after BOT_FILL_MS; from Gold II up, people only', () => {
    expect(findMatches([w('a', 1200)], '1v1', BOT_FILL_MS - 1)).toHaveLength(0);
    expect(ids(findMatches([w('a', 1200)], '1v1', BOT_FILL_MS))).toEqual([['a', 'bot']]);
    expect(ids(findMatches([w('a', 1399)], 'ffa', BOT_FILL_MS))).toEqual([['a', 'bot', 'bot', 'bot']]);
    expect(findMatches([w('a', 1400)], '1v1', 10 * BOT_FILL_MS)).toHaveLength(0);
    // A group with anyone from Gold II up waits for people too.
    expect(findMatches([w('a', 1395), w('b', 1420)], 'ffa', 10 * BOT_FILL_MS)).toHaveLength(0);
  });

  it('a group is allowed pair by pair: no one two leagues from anyone else in it', () => {
    // 2v2 at Silver/Gold edges after the widen: Silver 1290 fits Gold 1310, but Bronze 990 doesn't fit Gold.
    const m = findMatches([w('g', 1310), w('s', 1290), w('t', 1280), w('b', 990)], '2v2', BOT_FILL_MS - 1);
    expect(m).toHaveLength(0);
  });
});
