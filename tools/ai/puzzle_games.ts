// The daily puzzle generator's games (#99, #194), shared by tools/ai/puzzles.ts and tools/ai/puzzle_faces.ts:
// the same seed, layout and pairing play the very same game, so a puzzle's source can be replayed.
import { readFileSync } from 'node:fs';
import { createGame, move, roll, seeded, seededDie, type BotLevel, type GameState, type Move, type Rng, type Seat } from '../../src/engine';
import { chooseBotMove } from '../../src/engine/ai/levels';
import { Net } from '../../src/engine/ai/net';
import { decodeNet } from '../../src/engine/ai/netbin';
import { chooseExtreme } from '../../src/engine/ai/search';
import { MODES } from './common';

const root = new URL('../../../', import.meta.url);
export const netBytes = new Uint8Array(readFileSync(new URL('src/engine/ai/extreme-net.bin', root)));
const extremeNet = new Net(decodeNet(netBytes));

/** The games: 10 in a cycle, 6 of them 2p and 4 of them 4p, over the three pairings. */
export type Mix = 'hard-hard' | 'extreme-normal' | 'normal-normal';
export const MIX_LEVELS: Record<Mix, [BotLevel, BotLevel]> = { 'hard-hard': ['hard', 'hard'], 'extreme-normal': ['extreme', 'normal'], 'normal-normal': ['normal', 'normal'] };
export const CYCLE: [string, Mix][] = [
  ['2p', 'hard-hard'], ['2p', 'extreme-normal'], ['2p', 'normal-normal'], ['4p', 'hard-hard'], ['4p', 'extreme-normal'],
  ['2p', 'hard-hard'], ['2p', 'extreme-normal'], ['2p', 'normal-normal'], ['4p', 'normal-normal'], ['4p', 'extreme-normal'],
];

/** A bot's move at its level; Extreme with the shipped net (search depth 1, as the app without its worker). */
export function botMove(s: GameState, rng: Rng, level?: BotLevel): Move {
  const lv = level ?? s.players[s.current]!.level ?? 'normal';
  if (lv === 'extreme') return chooseExtreme(extremeNet, s, rng, { depth: 1 });
  if (lv === s.players[s.current]!.level) return chooseBotMove(s, rng);
  const players = s.players.map((p, i) => (i === s.current ? { ...p, level: lv } : p));
  return chooseBotMove({ ...s, players }, rng);
}

/** Every decision of one game (the states where the mover has 2+ moves), the app's dice, and the state before each. */
export function playGame(seed: number, layout: string, mix: Mix): { seats: Seat[]; decisions: GameState[]; before: GameState[] } {
  const [l0, l1] = MIX_LEVELS[mix];
  const seats: Seat[] = MODES[layout]!.seats().map((s, i) => ({ ...s, bot: true, level: i % 2 === 0 ? l0 : l1 }));
  const rng = seeded(seed * 31 + 7);
  let s = createGame(seats, seats[seed % seats.length]!.color, MODES[layout]!.singles);
  const decisions: GameState[] = [];
  const before: GameState[] = [];
  let prev = s;
  for (let n = 0; s.phase !== 'over' && n < 20000; n++) {
    const was = s;
    if (s.phase === 'roll') s = roll(s, () => 0, seededDie(seed, s));
    else {
      if (s.moves.length > 1) {
        decisions.push(s);
        before.push(prev);
      }
      s = move(s, botMove(s, rng));
    }
    prev = was;
  }
  return { seats, decisions, before };
}

