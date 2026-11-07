// Ranked bots played in the apps (#221): every app must play them the same way. These tests pin the bots' moves,
// rolls and pace to BOT_VERSION, and check the deterministic exp the rule bots use.
import { describe, expect, it } from 'vitest';
import { createGame, move, moveEvent, newGame, roll, seeded, type BotLevel, type GameState } from '../src/engine';
import { chooseRuleMove } from '../src/engine/ai/choose';
import { detExp } from '../src/engine/ai/detmath';
import { BOT_VERSION, botFace, botMove, botPace, type LocalBots } from '../src/net/localBots';
import golden from './fixtures/bot-moves.json';

const LEVELS: BotLevel[] = ['easy', 'normal', 'hard'];

/** Positions from a few seeded all-bot games (2 and 4 colours, doubles on and off), every few steps. */
function positions(): GameState[] {
  const out: GameState[] = [];
  const games: [GameState, number][] = [
    [newGame(4, [], false), 1],
    [newGame(4, [], true), 2],
    [newGame(2, [], false), 3],
    [createGame([{ color: 'blue', owner: 0, bot: true }, { color: 'red', owner: 0, bot: true }, { color: 'green', owner: 1, bot: true }, { color: 'yellow', owner: 1, bot: true }], 'blue', false), 4],
  ];
  for (const [start, seed] of games) {
    const rng = seeded(seed);
    let s = start;
    for (let step = 0; step < 600 && s.phase !== 'over'; step++) {
      if (step % 7 === 3) out.push(s);
      s = s.phase === 'roll' ? roll(s, rng) : move(s, chooseRuleMove(s, rng, 'normal'));
    }
  }
  return out;
}

/** What the bots do at each position: each level's move, a face for a few draws, and the pace. */
function record() {
  // Draws near where the faces meet, so a change in the dice shows.
  const draws = [0x28f5c28f, 0x2b851eb8, 0x570a3d70, 0x80000000, 0xa8f5c28f, 0xd70a3d70];
  return positions().map((s) => {
    const color = s.players[s.current]!.color;
    const bots = (level: BotLevel): LocalBots => ({ seed: 0xc0ffee, levels: { [color]: level } });
    return s.phase === 'move'
      ? { move: LEVELS.map((l) => moveEvent(botMove(s, bots(l)))), pace: botPace(s, bots('normal')) }
      : { faces: draws.map((d) => botFace(s, bots('normal'), d)), pace: botPace(s, bots('normal')) };
  });
}

describe('ranked bots played in the apps: the same everywhere (#221)', () => {
  it('detExp matches Math.exp to the last digits, across the range the bots use', () => {
    for (let x = -60; x <= 5; x += 0.0137) {
      const want = Math.exp(x);
      expect(Math.abs(detExp(x) - want) / want).toBeLessThan(4e-16);
    }
    expect(detExp(0)).toBe(1);
    expect(detExp(-800)).toBe(0);
    expect(detExp(800)).toBe(Infinity);
    expect(detExp(NaN)).toBeNaN();
  });

  it('the bots’ moves, rolls and pace are the ones recorded for this BOT_VERSION', () => {
    const now = record();
    // A change here changes the bots: bump BOT_VERSION in src/net/localBots.ts and remake the list with
    // UPDATE_BOT_MOVES=1 npx vitest run tests/local-bots.test.ts (apps on the old version then can't play ranked).
    const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
    if (env.UPDATE_BOT_MOVES === '1') {
      // @ts-expect-error: the project has no @types/node; Vitest runs on Node.
      return import(/* @vite-ignore */ 'node:fs').then((fs: { writeFileSync: (p: URL, s: string) => void }) =>
        fs.writeFileSync(new URL('./fixtures/bot-moves.json', import.meta.url), JSON.stringify({ version: BOT_VERSION, positions: now }) + '\n'),
      );
    }
    expect(golden.version, 'bot-moves.json was made for another BOT_VERSION: remake it').toBe(BOT_VERSION);
    expect(now.length).toBeGreaterThan(100);
    expect(now).toEqual(golden.positions);
  });
});
