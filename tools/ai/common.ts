// Shared by the self-play worker and the arena (tools/ai). Bundled with rolldown (build.sh) and run with
// Node, so the rules are the game's own TypeScript, never a copy.
import { readFileSync } from 'node:fs';
import { SEATS, analyzeDice, chooseMove, createGame, move, roll, sampleFace, type BotLevel, type GameState, type Move, type Rng, type Seat } from '../../src/engine';
import { Net, type NetJSON } from '../../src/engine/ai/net';
import { chooseExtreme } from '../../src/engine/ai/search';

export type Policy = (s: GameState, rng: Rng) => Move;

const nets = new Map<string, Net>();
const loadNet = (path: string) => nets.get(path) ?? nets.set(path, new Net(JSON.parse(readFileSync(path, 'utf8')) as NetJSON)).get(path)!;

/**
 * A policy from its name: easy | normal | hard | random | net:<weights.json>[:depth[:theirK[:temperature]]].
 * Rule bots play at their level whatever the seat says.
 */
export function policy(spec: string): Policy {
  if (spec === 'random') return (s, rng) => s.moves[Math.floor(rng() * s.moves.length)]!;
  if (spec === 'easy' || spec === 'normal' || spec === 'hard') {
    const level = spec as BotLevel;
    return (s, rng) => chooseMove({ ...s, players: s.players.map((p, i) => (i === s.current ? { ...p, level } : p)) }, rng);
  }
  if (spec.startsWith('net:')) {
    const [, path, depth, theirK, temp] = spec.split(':');
    const net = loadNet(path!);
    const opts = { depth: Number(depth ?? 1), theirK: Number(theirK ?? 3) };
    return (s, rng) => chooseExtreme(net, s, rng, opts, Number(temp ?? 0));
  }
  throw new Error(`unknown policy ${spec}`);
}

/** Table setups by name: the seats (who owns which colour) and whether doubles are off. */
export const MODES: Record<string, { seats: () => Seat[]; singles: boolean }> = {};
const ALL = ['blue', 'green', 'red', 'yellow'] as const;
for (const singles of [false, true]) {
  const tag = singles ? '-singles' : '';
  for (const n of [2, 3, 4] as const) MODES[`${n}p${tag}`] = { singles, seats: () => SEATS[n].map((color, owner) => ({ color, owner, bot: true })) };
  MODES[`2h-opposite${tag}`] = { singles, seats: () => ALL.map((color) => ({ color, owner: color === 'blue' || color === 'red' ? 0 : 1, bot: true })) };
  MODES[`2h-side${tag}`] = { singles, seats: () => ALL.map((color) => ({ color, owner: color === 'blue' || color === 'green' ? 0 : 1, bot: true })) };
}

export const peopleIn = (mode: string) => Math.max(...MODES[mode]!.seats().map((s) => s.owner)) + 1;

/**
 * Plays one game with the game's real dice. `byOwner[o]` plays every colour of person o, `first` is the
 * index of the colour that starts. `onRoll` sees every position before a roll: turn starts, and mid-turn
 * ones (after a 6, a kill or a token home), which the search also scores.
 */
export function playGame(mode: string, byOwner: Policy[], rng: Rng, first: number, onRoll?: (s: GameState) => void): GameState {
  const m = MODES[mode]!;
  let s = createGame(m.seats(), undefined, m.singles);
  s = { ...s, current: first % s.players.length };
  for (let steps = 0; s.phase !== 'over' && steps < 50000; steps++) {
    if (s.phase === 'roll') {
      onRoll?.(s);
      s = roll(s, rng, sampleFace(analyzeDice(s.players, s.players[s.current]!.color, rng, s.singles).weights, rng));
    } else s = move(s, byOwner[s.players[s.current]!.owner]!(s, rng));
  }
  return s;
}

/** Command-line flags given as --name value. */
export function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) if (argv[i]!.startsWith('--')) out[argv[i]!.slice(2)] = argv[i + 1] ?? '';
  return out;
}
