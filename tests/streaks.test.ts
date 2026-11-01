// The streaks and level stats behind the achievements (src/ui/store.ts): Extreme streaks count only Extreme
// games, and a loss, a quit or an abandoned save ends them.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newGame, type BotLevel, type GameState } from '../src/engine';
import type { GameConfig } from '../src/ui/setup';

const mem = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: mem.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => void mem.set(key, value),
    remove: async ({ key }: { key: string }) => void mem.delete(key),
  },
}));
const { giveUpSaved, giveUpNote, layoutOf, levelOf, loadStats, recordGame, saveGame } = await import('../src/ui/store');

const game = (level: BotLevel, place: number, layout = '2p', quit = false) => recordGame({ mode: 'pvc', place, kills: 1, pairs: 0, level, layout, quit });
const withBots = (levels: (BotLevel | undefined)[]): GameState => {
  const g = newGame(4);
  return { ...g, players: g.players.map((p, i) => (i === 0 ? { ...p, bot: false } : { ...p, bot: true, level: levels[i - 1] })) };
};

describe('Extreme streaks', () => {
  beforeEach(() => mem.clear());

  it('grow with Extreme wins and ignore games at other levels in between', async () => {
    await game('extreme', 1);
    await game('hard', 1);
    await game('normal', 3);
    const s = await game('extreme', 1, '4p');
    expect(s).toMatchObject({ xStreak: 2, xBestStreak: 2, streak: 1, xModes: ['2p', '4p'] });
    expect(s.levelWins).toEqual({ easy: 0, normal: 0, hard: 1, extreme: 2 });
  });

  it('end with an Extreme loss, keeping the best', async () => {
    for (let i = 0; i < 3; i++) await game('extreme', 1);
    expect(await game('extreme', 2)).toMatchObject({ xStreak: 0, xBestStreak: 3 });
  });

  it('end with an Extreme quit; a quit at another level only ends the overall streak', async () => {
    await game('extreme', 1);
    expect(await game('hard', 0, '2p', true)).toMatchObject({ xStreak: 1, streak: 0, played: 2, kills: 1 });
    expect(await game('extreme', 0, '2p', true)).toMatchObject({ xStreak: 0, played: 3, kills: 1 });
  });

  it('end when an Extreme save is given up for a new game', async () => {
    await game('extreme', 1);
    const config: GameConfig = { mode: 'pvc', seats: [], first: 'blue', names: ['You', 'A', 'B', 'C'] };
    await saveGame({ v: 1, config, state: { ...withBots(['extreme', 'extreme', 'extreme']), turnCount: 8 }, kills: 0, pairs: 0, faces: [], savedAt: 0 });
    await giveUpSaved();
    expect(await loadStats()).toMatchObject({ xStreak: 0, xBestStreak: 1, played: 2 });
  });

  it('are named first in the give-up warning for an Extreme game', async () => {
    await game('extreme', 1);
    await game('extreme', 1);
    const s = await loadStats();
    expect(giveUpNote(s, 'extreme')).toBe('It counts as a loss and ends your Extreme streak of 2.');
    expect(giveUpNote(s, 'hard')).toBe('It counts as a loss and ends your win streak of 2.');
    expect(giveUpNote({ ...s, streak: 0 }, 'hard')).toBe('It counts as a loss.');
  });

  it('start from zero on devices with stats from before', async () => {
    mem.set('ludo-stats', JSON.stringify({ played: 5, wins: 2 }));
    const s = await game('extreme', 1);
    expect(s).toMatchObject({ played: 6, wins: 3, xStreak: 1, checkinBest: 0 });
    expect(s.levelWins.extreme).toBe(1);
  });
});

describe('a game for the achievements', () => {
  it('has the level of its weakest bot', () => {
    expect(levelOf(withBots(['extreme', 'hard', 'extreme']))).toBe('hard');
    expect(levelOf(withBots(['extreme', undefined, 'extreme']))).toBe('normal');
    expect(levelOf(withBots(['extreme', 'extreme', 'extreme']))).toBe('extreme');
  });

  it('knows its layout', () => {
    const g = newGame(4);
    const owners = (o: number[]) => ({ ...g, players: g.players.map((p, i) => ({ ...p, owner: o[i]! })) });
    expect(layoutOf(g)).toBe('4p');
    expect(layoutOf(newGame(2))).toBe('2p');
    // Colours in order blue, green, red, yellow: blue and red sit opposite.
    expect(layoutOf(owners([0, 1, 0, 1]))).toBe('2h-opposite');
    expect(layoutOf(owners([0, 0, 1, 1]))).toBe('2h-side');
  });
});
