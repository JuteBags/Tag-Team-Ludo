// The bot levels the app plays: Easy and Normal are the original rule bots (bot.ts); Hard plans its whole
// turn with readable weighted rules (hard-rules.ts); Extreme plans its whole turn with the trained value
// net (extreme-net.json, from self-play). The net is loaded on first use, so it costs nothing until then.
import { chooseMove } from '../bot';
import type { GameState, Move, Rng } from '../types';
import { HARD_RULES } from './hard-rules';
import { LinearRules } from './linear';
import { Net, type NetJSON } from './net';
import { chooseExtreme } from './search';

const hard = new LinearRules(HARD_RULES);
let extreme: Net | null = null;

/** Loads Extreme's net (once). Until it is loaded, Extreme plays like Hard. */
export async function loadExtreme(): Promise<void> {
  if (!extreme) extreme = new Net((await import('./extreme-net.json')).default as unknown as NetJSON);
}

/** The move the current player's bot picks, by its level. */
export function chooseBotMove(state: GameState, rng: Rng): Move {
  const level = state.players[state.current]!.level ?? 'normal';
  if (level === 'extreme' && extreme) return chooseExtreme(extreme, state, rng, { depth: 1 });
  if (level === 'hard' || level === 'extreme') return chooseExtreme(hard, state, rng, { depth: 1 });
  return chooseMove(state, rng);
}
