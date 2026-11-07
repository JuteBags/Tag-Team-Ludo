// Ranked bots, played in the players' apps (#221). Pure, shared by the app (which plays the bots) and the room
// server (which checks what the apps send), and tested in tests/local-bots.test.ts.
//
// - The server never picks a bot's move. Every person's app plays the bots at the game's `seed` (move choices
//   and pace only), so every app gets the same moves.
// - The dice stay the server's. When the bots' turn comes, the server sends fresh random draws for that run of
//   bot turns (`Draws`, with spares); an app turns each draw into a face exactly as the server rolls for anyone.
//   Draws are used once: the spares of a run are thrown away when the run ends.
// - Nothing is sent per bot turn. The run's events ride along with the next person's roll or move (`bots`), and
//   the server checks them: each roll against its draw, each move against the rules. Another app that played
//   the run differently says so (`mismatch`, logged) and takes the server's version.
// - Only apps on the server's BOT_VERSION may play such a game: a different bot gives different moves.
import { chooseRuleMove } from '../engine/ai/choose';
import { createGame, move, roll } from '../engine/game';
import { applyEvent, moveEvent, rollEvent, STOP_EVENT } from '../engine/record';
import { diceWeights, sampleFace } from '../engine/dice';
import { mixSeed, positionKey, seeded } from '../engine/rng';
import type { BotLevel, Color, GameState, Move, Seat } from '../engine';

/**
 * The bots' version. Bump it on any change that could change a bot's move, roll or pace for the same position
 * and seed: the rule bots (src/engine/ai, bot.ts), the rules, the dice, or this file. tests/local-bots.test.ts
 * keeps a list of moves for it and fails until it's bumped (and the list remade).
 */
export const BOT_VERSION = 1;
/** Draws sent per bot seat for one run of bot turns (most turns take 1-2 rolls; the rest are spares). */
export const DRAWS_PER_BOT = 10;
/** The most bot events one message may carry. */
export const MAX_BOT_EVENTS = 200;

/** The bots in a game: their seed (moves and pace only) and level by colour. Colours not listed are people's. */
export interface LocalBots {
  seed: number;
  levels: Partial<Record<Color, BotLevel>>;
}

/** Random draws (32-bit) for the run of bot turns that starts at event `at`. */
export interface Draws {
  at: number;
  d: number[];
}

/** Whether the colour to play at `s` is one of the bots. */
export const isLocalBot = (s: GameState, bots: LocalBots | null | undefined) => !!bots && s.phase !== 'over' && bots.levels[s.players[s.current]!.color] !== undefined;

/** A draw as a number in [0, 1). */
const unit = (d: number) => (d >>> 0) / 4294967296;

/** The face a bot rolls at `s` with `draw`: the app's dice, as the server rolls for a person. */
export function botFace(s: GameState, bots: LocalBots, draw: number): number {
  const color = s.players[s.current]!.color;
  const weights = diceWeights(s.players, color, seeded(mixSeed(bots.seed, 'dice' + positionKey(s))), s.singles);
  return sampleFace(weights, () => unit(draw));
}

/** The move a bot plays at `s` (the rule bot of its level, at the bots' seed). */
export function botMove(s: GameState, bots: LocalBots): Move {
  const level = bots.levels[s.players[s.current]!.color] ?? 'normal';
  return chooseRuleMove(s, seeded(mixSeed(bots.seed, 'bot' + positionKey(s))), level);
}

/** A bot step takes a person's time (#216): 1.2-2.6 s to roll, 1.5-3.5 s to move. */
export const humanPace = (phase: GameState['phase'], random: () => number) => Math.round(phase === 'roll' ? 1200 + 1400 * random() : 1500 + 2000 * random());
/** How long the bot takes over its step at `s`. */
export const botPace = (s: GameState, bots: LocalBots) => humanPace(s.phase, seeded(mixSeed(bots.seed, 'pace' + positionKey(s))));

/**
 * One bot step at `s`: a roll with the next draw (`draws[used]`), or the bot's move. Null when the roll has no
 * draw left (the app asks the server for more).
 */
export function botStep(s: GameState, bots: LocalBots, draws: readonly number[], used: number): { ev: string; next: GameState; used: number } | null {
  if (s.phase === 'roll') {
    const draw = draws[used];
    if (draw === undefined) return null;
    const face = botFace(s, bots, draw);
    return { ev: rollEvent(face), next: roll(s, () => 0, face), used: used + 1 };
  }
  const m = botMove(s, bots);
  return { ev: moveEvent(m), next: move(s, m), used };
}

/**
 * The server's check of a run of bot events from an app, from `s` with the run's draws (`used` taken so far).
 * Each roll must be the face its draw gives, each move a legal one; every event must be a bot's. The server
 * doesn't pick moves, so a legal move that isn't what the bot would play passes here (the other apps catch it).
 */
export function checkBotEvents(s: GameState, bots: LocalBots, draws: readonly number[], used: number, evs: readonly string[]): { states: GameState[]; used: number } | { error: string } {
  const states: GameState[] = [];
  if (evs.length > MAX_BOT_EVENTS) return { error: 'too many bot events' };
  for (const ev of evs) {
    if (typeof ev !== 'string' || !isLocalBot(s, bots)) return { error: 'an event that is not a bot’s' };
    if (s.phase === 'roll') {
      const draw = draws[used];
      if (draw === undefined) return { error: 'a roll without a draw' };
      const face = botFace(s, bots, draw);
      if (ev !== rollEvent(face)) return { error: `roll ${ev} where the draw gives ${face}` };
      s = roll(s, () => 0, face);
      used++;
    } else {
      const m = s.moves.find((x) => moveEvent(x) === ev);
      if (!m) return { error: `illegal move ${ev}` };
      s = move(s, m);
    }
    states.push(s);
  }
  return { states, used };
}

/** The first legal move: what the server plays for a bot nobody sent a move for (no picker, #221). */
export const firstLegal = (s: GameState): Move => s.moves[0]!;

/** The game after `events` from `seats` (stops at the stop marker). */
export function replayEvents(seats: Seat[], first: Color, singles: boolean, events: readonly string[]): GameState {
  let s = createGame(seats, first, singles);
  for (const ev of events) {
    if (ev === STOP_EVENT) break;
    s = applyEvent(s, ev);
  }
  return s;
}

/** Draws of the run starting at `at` that the bots' rolls in `events[at..]` have used. */
export function drawsUsed(seats: Seat[], first: Color, singles: boolean, events: readonly string[], at: number, bots: LocalBots): number {
  let s = replayEvents(seats, first, singles, events.slice(0, at));
  let used = 0;
  for (const ev of events.slice(at)) {
    if (ev === STOP_EVENT || s.phase === 'over') break;
    if (s.phase === 'roll' && isLocalBot(s, bots)) used++;
    s = applyEvent(s, ev);
  }
  return used;
}
