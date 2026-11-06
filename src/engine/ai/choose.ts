// The rule bots by level, with no worker, net or WebAssembly: what levels.ts plays for Easy, Normal and Hard
// (and for Extreme before its net loads), and what the online server plays for its bots.
import { chooseMove } from '../bot';
import type { BotLevel, GameState, Move, Rng } from '../types';
import { HARD_RULES } from './hard-rules';
import { LinearRules } from './linear';
import { chooseExtreme, chooseGreedy } from './search';

const hard = new LinearRules(HARD_RULES);

/** The move a rule bot of `level` picks: Hard (and Extreme without its net) plans the turn, Normal judges each move alone, Easy is bot.ts's Hard. */
export function chooseRuleMove(state: GameState, rng: Rng, level: BotLevel): Move {
  if (level === 'hard' || level === 'extreme') return chooseExtreme(hard, state, rng, { depth: 1 });
  if (level === 'normal') return chooseGreedy(hard, state, rng);
  return chooseMove(state, rng, 'hard');
}
