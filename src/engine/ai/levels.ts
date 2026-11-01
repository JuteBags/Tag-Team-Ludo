// The bot levels the app plays, each a step above the last (4p, one house against three of the level
// below: Normal 32.8% vs Easy, Hard 30.5% vs Normal; 25% is even):
//   Easy     the original Hard rule bot (bot.ts)
//   Normal   Hard's weighted rules (hard-rules.ts), each move judged alone (no planning of the turn)
//   Hard     the same rules, planning the whole turn (search.ts, depth 1)
//   Extreme  the rollout player (rollout.ts, WebAssembly in a worker): every move played out on shared
//            dice, Hard's rules playing every seat, the trained value net (extreme-net.json) scoring
//            where the playouts stop. Without workers it plans its turn with the net alone.
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

/** Playouts per candidate move, at most (the race stops clear decisions far earlier). */
export const EXTREME_PLAYOUTS = 256;

let worker: Worker | null | undefined;
let nextId = 0;
const pending = new Map<number, (index: number) => void>();

/** The rollout worker, started on first use; null where workers cannot run (tests, old WebViews). */
function rolloutWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./rollout-worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return (worker = null);
  }
  worker.onmessage = (e: MessageEvent<{ id: number; index?: number }>) => {
    pending.get(e.data.id)?.(e.data.index ?? -1);
    pending.delete(e.data.id);
  };
  // A worker that fails to load answers every move with the net alone, from then on.
  worker.onerror = () => {
    for (const done of pending.values()) done(-1);
    pending.clear();
    worker = null;
  };
  return worker;
}

/** chooseBotMove, with Extreme's rollouts in the worker (the UI keeps running while it thinks). */
export async function chooseBotMoveAsync(state: GameState, rng: Rng): Promise<Move> {
  const w = state.players[state.current]!.level === 'extreme' && state.moves.length > 1 && typeof Worker !== 'undefined' ? rolloutWorker() : null;
  if (w) {
    const id = nextId++;
    const seed = Math.floor(rng() * 4294967296);
    const index = await new Promise<number>((done) => {
      pending.set(id, done);
      w.postMessage({ id, state, nmax: EXTREME_PLAYOUTS, seed });
    });
    const m = state.moves[index];
    if (m) return m;
  }
  if (state.players[state.current]!.level === 'extreme') await loadExtreme();
  return chooseBotMove(state, rng);
}
