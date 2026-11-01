// The bot levels the app plays, each a step above the last (4p, one house against three of the level
// below: Normal 32.8% vs Easy, Hard 30.5% vs Normal; 25% is even):
//   Easy     the original Hard rule bot (bot.ts)
//   Normal   Hard's weighted rules (hard-rules.ts), each move judged alone (no planning of the turn)
//   Hard     the same rules, planning the whole turn (search.ts, depth 1)
//   Extreme  plans its whole turn with the trained value net (extreme-net.json), loaded on first use.
import { chooseMove } from '../bot';
import type { GameState, Move, Rng } from '../types';
import { HARD_RULES } from './hard-rules';
import { LinearRules } from './linear';
import { Net, type NetJSON } from './net';
import { chooseExtreme, chooseGreedy } from './search';

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
  if (level === 'normal') return chooseGreedy(hard, state, rng);
  return chooseMove(state, rng, 'hard');
}
