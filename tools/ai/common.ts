// Shared by the self-play worker and the arena (tools/ai). Bundled with rolldown (build.sh) and run with
// Node, so the rules are the game's own TypeScript, never a copy.
import { readFileSync } from 'node:fs';
import { SEATS, analyzeDice, chooseMove, createGame, move, roll, sampleFace, seeded, type BotLevel, type GameState, type Move, type Rng, type Seat } from '../../src/engine';
import { Blend } from '../../src/engine/ai/blend';
import { LinearRules, type Evaluator, type LinearJSON } from '../../src/engine/ai/linear';
import { Net, type NetJSON } from '../../src/engine/ai/net';
import { chooseExtreme } from '../../src/engine/ai/search';

export type Policy = (s: GameState, rng: Rng) => Move;

/**
 * Version 2 of shards and traces: the dice draw from their own stream, seeded(gameSeed ^ DICE_SALT), and
 * the policies (tie-breaks, random picks, temperature) from the game's rng. Policies then cannot move the
 * dice, and paired games in the arena use the same stream of dice numbers for both seats.
 */
export const FORMAT = 2;
export const DICE_SALT = 0x2545f491;
export const diceRngFor = (gameSeed: number) => seeded(gameSeed ^ DICE_SALT);

/**
 * Which dice a run uses: 'game' = the app's dice (dice.ts), 'fair' = every face 1 in 6. The engine
 * trains and is measured on fair dice (the user's rule: for the engine every face is 1/6); the app's dice
 * are tuned separately. A fair roll is sampleFace(FAIR, dice): one draw, no shuffle.
 */
export type DiceMode = 'game' | 'fair';
const FAIR = [1, 1, 1, 1, 1, 1].map((x) => x / 6);
export const rollFace = (s: GameState, dice: Rng, mode: DiceMode) =>
  mode === 'fair' ? sampleFace(FAIR, dice) : sampleFace(analyzeDice(s.players, s.players[s.current]!.color, dice, s.singles).weights, dice);

// A weights file is a value net (net.ts) or readable linear rules (linear.ts, "kind": "linear").
const nets = new Map<string, Evaluator>();
function loadNet(path: string): Evaluator {
  if (!nets.has(path)) {
    const json = JSON.parse(readFileSync(path, 'utf8')) as NetJSON | LinearJSON;
    nets.set(path, 'kind' in json && json.kind === 'linear' ? new LinearRules(json) : new Net(json as NetJSON));
  }
  return nets.get(path)!;
}

/**
 * A policy from its name: easy | normal | hard | random |
 * net:<weights.json>[:depth[:theirK[:temperature[:race[:chance[:cut]]]]]]
 * (race = 1: exact values from the race database in v1 race positions, search.ts SearchOptions.race;
 * chance: chance nodes allowed within one turn before the value takes over, default 2).
 * The weights file can be a value net or linear rules (then it is a rule bot that plans whole turns).
 * Rule bots play at their level whatever the seat says.
 */
export function policy(spec: string): Policy {
  if (spec === 'random') return (s, rng) => s.moves[Math.floor(rng() * s.moves.length)]!;
  if (spec === 'easy' || spec === 'normal' || spec === 'hard') {
    const level = spec as BotLevel;
    return (s, rng) => chooseMove({ ...s, players: s.players.map((p, i) => (i === s.current ? { ...p, level } : p)) }, rng);
  }
  if (spec.startsWith('net:')) {
    const [, path, depth, theirK, temp, race, chance, cut] = spec.split(':');
    const net = loadNet(path!);
    const opts = { depth: Number(depth ?? 1), theirK: Number(theirK ?? 3), race: race === '1', chance: Number(chance ?? 2), cut: Number(cut ?? 0) };
    return (s, rng) => chooseExtreme(net, s, rng, opts, Number(temp ?? 0));
  }
  if (spec.startsWith('blend:')) {
    // blend:<net.json>:<rules.json>:<alpha>[:depth[:theirK[:temperature[:race[:chance[:cut]]]]]]
    const [, netPath, rulesPath, alpha, depth, theirK, temp, race, chance, cut] = spec.split(':');
    const net = loadNet(netPath!) as Net;
    const rules = loadNet(rulesPath!) as LinearRules;
    const ev = new Blend(net, rules, Number(alpha));
    const opts = { depth: Number(depth ?? 1), theirK: Number(theirK ?? 3), race: race === '1', chance: Number(chance ?? 2), cut: Number(cut ?? 0) };
    return (s, rng) => chooseExtreme(ev, s, rng, opts, Number(temp ?? 0));
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
 * Plays one game, the dice drawn from `dice` (the app's dice, or fair ones with diceMode 'fair'); the
 * policies draw from `rng`. `byOwner[o]`
 * plays every colour of person o, `first` is the index of the colour that starts. `onRoll` sees every position before a roll: turn starts, and mid-turn
 * ones (after a 6, a kill or a token home), which the search also scores.
 */
export function playGame(mode: string, byOwner: Policy[], rng: Rng, dice: Rng, first: number, onRoll?: (s: GameState) => void, diceMode: DiceMode = 'game'): GameState {
  const m = MODES[mode]!;
  let s = createGame(m.seats(), undefined, m.singles);
  s = { ...s, current: first % s.players.length };
  for (let steps = 0; s.phase !== 'over' && steps < 50000; steps++) {
    if (s.phase === 'roll') {
      onRoll?.(s);
      s = roll(s, dice, rollFace(s, dice, diceMode));
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
