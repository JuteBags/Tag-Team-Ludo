// Hard's readable rules (linear.ts): each weight is one rule, and Hard plans its whole turn with them
// (search.ts, depth 1). Hard v3: fitted to paired-rollout expert data, then tuned for strength with CMA-ES
// in 4p (tools/ai/tune.py); one Hard v3 house wins 26.5% against three Hard v2 houses (80k games, 25% is
// even). Normal plays the same rules greedily. Regenerate from W&B model hardv3-cma (hardv3-cma.json).
import type { LinearJSON } from './linear';

export const HARD_RULES: LinearJSON = {
  kind: 'linear',
  weights: {
    pipsLeft: -5.648935,
    base: -1.743459,
    home: 0.041444,
    column: -0.2258401,
    danger: -0.6283621,
    dangerProg: -8.514323,
    prey: 0.07699,
    preyProg: -0.06176514,
    safe: 0.3049848,
    blocks: -0.1222186,
    blocking: -0.1417582,
    ambush: 0.03726355,
    maxProg: -0.007994518,
    minProg: -0.4207561,
    turn0: 0.1031253,
    turn1: -0.3520965,
    turn2: -0.07312084,
    turn3: -0.4457917,
    tray1: 0.1680173,
    tray2: -0.01224175,
    tray3: 0.4307844,
    tray4: 0.1629812,
    tray5: 1.695677,
    tray6: 0.4886146,
    sixes: 0.05235575,
  },
};
