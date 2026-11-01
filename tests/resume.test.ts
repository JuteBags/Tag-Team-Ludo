// Fair resume (gameScreen.ts, store.ts): a continued game rolls the dice it would have rolled, and giving a game
// up vs Computer (quitting it, or starting a new one over its save) counts as a loss after the first round.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mixSeed, newGame, positionKey, roll, seeded, type GameState } from '../src/engine';
import type { GameConfig } from '../src/ui/setup';

// Capacitor Preferences in memory (Node has no localStorage).
const mem = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: mem.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => void mem.set(key, value),
    remove: async ({ key }: { key: string }) => void mem.delete(key),
  },
}));
const { giveUpSaved, givingUpLoses, loadGame, loadStats, recordGame, saveGame } = await import('../src/ui/store');

const pvc: GameConfig = { mode: 'pvc', seats: [], first: 'blue', names: ['You', 'Bot'] };
const at = (turnCount: number): GameState => ({ ...newGame(2), turnCount });
const dice = (seed: number, s: GameState) => roll(s, seeded(mixSeed(seed, 'dice' + positionKey(s)))).dice;

describe('fair resume', () => {
  it('rolls the same dice for the same position, also after a save and load', () => {
    const s = at(5);
    const back = JSON.parse(JSON.stringify(s)) as GameState;
    expect(positionKey(back)).toBe(positionKey(s));
    for (const seed of [1, 2, 3, 99]) expect(dice(seed, back)).toBe(dice(seed, s));
  });

  it('rolls new dice when the position is different', () => {
    const a = at(5);
    const b = { ...a, players: a.players.map((p, i) => (i ? p : { ...p, tokens: [3, -1, -1, -1] })) };
    expect(positionKey(b)).not.toBe(positionKey(a));
    // Over many seeds the two positions' dice are independent, not the same stream.
    const same = Array.from({ length: 200 }, (_, k) => dice(k, a) === dice(k, b)).filter(Boolean).length;
    expect(same).toBeLessThan(70);
  });
});

describe('giving a game up', () => {
  beforeEach(() => mem.clear());

  it('is free in the first round and with friends, a loss after that', () => {
    expect(givingUpLoses({ config: pvc, state: at(1) })).toBe(false);
    expect(givingUpLoses({ config: pvc, state: at(2) })).toBe(true);
    expect(givingUpLoses({ config: { ...pvc, mode: 'pvp' }, state: at(9) })).toBe(false);
    expect(givingUpLoses({ config: pvc, state: at(9), counted: true })).toBe(false);
  });

  it('a quit counts as played and lost, ends the streak, and adds nothing else', async () => {
    await recordGame({ mode: 'pvc', place: 1, kills: 2, pairs: 0 });
    await recordGame({ mode: 'pvc', place: 1, kills: 1, pairs: 0 });
    const s = await recordGame({ mode: 'pvc', place: 0, kills: 0, pairs: 0, quit: true });
    expect(s).toMatchObject({ played: 3, wins: 2, streak: 0, bestStreak: 2, kills: 3, best: 1 });
  });

  it('a new game over a save counts it once, then clears it', async () => {
    await saveGame({ v: 1, config: pvc, state: at(4), kills: 0, pairs: 0, faces: [], savedAt: 0, seed: 7 });
    await giveUpSaved();
    expect(await loadGame()).toBeNull();
    await giveUpSaved();
    expect((await loadStats()).played).toBe(1);
  });

  it('a save already counted is never offered or counted again', async () => {
    await saveGame({ v: 1, config: pvc, state: at(4), kills: 0, pairs: 0, faces: [], savedAt: 0, counted: true });
    expect(await loadGame()).toBeNull();
    await giveUpSaved();
    expect((await loadStats()).played).toBe(0);
  });

  it('a save from the first round is given up for free', async () => {
    await saveGame({ v: 1, config: pvc, state: at(1), kills: 0, pairs: 0, faces: [], savedAt: 0 });
    await giveUpSaved();
    expect((await loadStats()).played).toBe(0);
  });
});

describe('past games', () => {
  beforeEach(() => mem.clear());

  it('keeps the newest games first, up to KEEP_GAMES', async () => {
    const { KEEP_GAMES, loadPastGames, savePastGame } = await import('../src/ui/store');
    for (let i = 0; i < KEEP_GAMES + 3; i++) await savePastGame({ rec: { v: 1, seats: [], first: 'blue', events: String(i) }, at: i, mode: 'pvc', place: 1 });
    const games = await loadPastGames();
    expect(games.length).toBe(KEEP_GAMES);
    expect(games[0]!.at).toBe(KEEP_GAMES + 2);
    expect(games.at(-1)!.at).toBe(3);
  });
});
