// The rules that play every seat in Extreme's playouts: Hard v2 (linear.ts), the previous Hard, fitted to
// self-play results and tuned with CMA-ES (tools/ai/tune.py). Extreme was measured with these playouts
// (and the cheaper one-bonus-roll search, sim-wasm); Hard v3 in their place played no better.
// Regenerate from the tuning run's hard2-tuned.json.
import type { LinearJSON } from './linear';

export const PLAYOUT_RULES: LinearJSON = {
  kind: 'linear',
  weights: {
    pipsLeft: -4.500122,
    base: -1.307343,
    home: 0.05509106,
    column: -0.1143852,
    danger: -1.187086,
    dangerProg: -7.596198,
    prey: 0.1991133,
    preyProg: 0.2925503,
    safe: 0.3119276,
    blocks: -0.4041692,
    blocking: -0.2190059,
    ambush: 0.01355702,
    maxProg: -0.1214291,
    minProg: -0.3744152,
    turn0: 0.1292117,
    turn1: -0.1977972,
    turn2: -0.1173747,
    turn3: -0.2899648,
    tray1: 0.2289285,
    tray2: -0.03510049,
    tray3: 0.436761,
    tray4: 0.1233671,
    tray5: 1.168914,
    tray6: 0.9137911,
    sixes: 0.0963633,
  },
};
