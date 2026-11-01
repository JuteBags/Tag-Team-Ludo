// Extreme: expectimax over whole turns, max^n for several players, with the value net at the leaves
// (or, for the rule bots, readable weighted rules: linear.ts).
// A turn is planned whole: every order of playing the tray's dice, with any extra roll (after a 6, a
// kill or a token home) as a chance node. At depth 2 the next player's turn follows, and they play the
// way the net thinks is best for THEM (max^n: each player maximises their own chance), not worst-case
// for me. Every face counts 1 in 6: the engine assumes fair dice, like the people playing it.
import { scoreMove } from '../bot';
import { move, ownerRanking, roll } from '../game';
import type { GameState, Move, Rng } from '../types';
import type { Evaluator } from './linear';
import { raceChances } from './race';

export interface SearchOptions {
  /** Turns looked at: 1 = my turn only, 2 = also the next player's, and so on. */
  depth?: number;
  /** Chance nodes allowed within one turn before the value takes over. */
  chance?: number;
  /** Moves other players consider at each decision, best first by the Hard rules (0 = all). */
  theirK?: number;
  /** Value v1 race positions (every token in a home column) exactly with the race database (race.ts). */
  race?: boolean;
  /** ChanceProbCut-style cut (0 = off, exact search). A child that would be searched further (an extra
   * roll in this turn, or the next turn) is first valued by the evaluator alone, its probe; children are
   * searched best probe first, and one whose probe for the player choosing is at least `cut` below the
   * best value searched so far keeps its probe. Not exact: a move the probe underrates by more than
   * `cut` is missed. Values stay a function of the position, so the memo is unaffected. */
  cut?: number;
}

const FACES = [1, 2, 3, 4, 5, 6];
const noRng: Rng = () => 0.5;
// The finishing order is part of the key: two positions with the same tokens can differ in who is home first.
const key = (s: GameState) => `${s.current}|${s.phase}|${s.sixes}|${s.rolls.join('')}|${s.ranking.join('')}|${s.players.map((p) => p.tokens.join(',')).join(';')}`;

/** Each person's chance of winning, by owner; with `race`, exact in v1 race positions. */
export function ownerValues(net: Evaluator, s: GameState, owners: number, race = false): Float64Array {
  if (s.phase === 'over') {
    const v = new Float64Array(owners);
    v[ownerRanking(s)[0]!] = 1;
    return v;
  }
  if (race) {
    const r = raceChances(s);
    if (r) return r;
  }
  return net.ownerChances(s);
}

/** The search's value of each of the current player's moves, as that player's chance of winning. */
export function searchValues(net: Evaluator, state: GameState, opts: SearchOptions = {}): { move: Move; value: number }[] {
  const depth = opts.depth ?? 1;
  const maxChance = opts.chance ?? 2;
  const theirK = opts.theirK ?? 3;
  const race = opts.race ?? false;
  const cut = opts.cut ?? 0;
  const owners = Math.max(...state.players.map((p) => p.owner)) + 1;
  const root = state.current;
  const memo = new Map<string, Float64Array>();
  const rootOwner = state.players[root]!.owner;

  // `turnsLeft` counts the turns still to search, this one included; `who` is whose turn it is.
  function node(s: GameState, who: number, turnsLeft: number, chance: number): Float64Array {
    if (s.phase === 'over') return ownerValues(net, s, owners, race);
    if (s.current !== who) return turnsLeft > 1 ? node(s, s.current, turnsLeft - 1, 0) : ownerValues(net, s, owners, race);
    const k = `${key(s)}|${turnsLeft}|${chance}`;
    const hit = memo.get(k);
    if (hit) return hit;
    let v: Float64Array;
    if (s.phase === 'move') {
      const me = s.players[who]!.owner;
      let moves = s.moves;
      if (me !== rootOwner && theirK > 0 && moves.length > theirK) moves = [...moves].sort((a, b) => scoreMove(s, b) - scoreMove(s, a)).slice(0, theirK);
      v = new Float64Array(owners).fill(-1);
      for (const c of children(s, moves, who, turnsLeft, chance, me)) if (c[me]! > v[me]!) v = c;
    } else if (chance >= maxChance) {
      v = ownerValues(net, s, owners, race);
    } else {
      v = new Float64Array(owners);
      for (const f of FACES) {
        const c = node(roll(s, noRng, f), who, turnsLeft, chance + 1);
        for (let o = 0; o < owners; o++) v[o]! += c[o]! / 6;
      }
    }
    memo.set(k, v);
    return v;
  }

  // Each move's child value, in `moves` order (see SearchOptions.cut).
  function children(s: GameState, moves: Move[], who: number, turnsLeft: number, chance: number, me: number): Float64Array[] {
    const ts = moves.map((m) => move(s, m));
    if (cut <= 0) return ts.map((t) => node(t, who, turnsLeft, chance));
    const deep = (t: GameState) => t.phase === 'roll' && (t.current === who ? chance < maxChance : turnsLeft > 1);
    const vals = new Array<Float64Array>(ts.length);
    const probes: [number, Float64Array][] = [];
    let a = -1;
    ts.forEach((t, i) => {
      if (deep(t)) {
        probes.push([i, ownerValues(net, t, owners, race)]);
        searchStats.probes++;
      } else {
        vals[i] = node(t, who, turnsLeft, chance);
        if (vals[i]![me]! > a) a = vals[i]![me]!;
      }
    });
    probes.sort((x, y) => y[1][me]! - x[1][me]!);
    for (const [i, p] of probes) {
      if (p[me]! + cut <= a) {
        vals[i] = p;
        searchStats.cuts++;
      } else {
        vals[i] = node(ts[i]!, who, turnsLeft, chance);
        if (vals[i]![me]! > a) a = vals[i]![me]!;
      }
    }
    return vals;
  }

  const me = state.players[root]!.owner;
  return children(state, state.moves, root, depth, 0, me).map((v, i) => ({ move: state.moves[i]!, value: v[me]! }));
}

/** How often sampling (temperature > 0) picked a move other than the best (exploration), and how many
 * children the cut probed and kept at their probe: counted for logs. */
export const searchStats = { sampled: 0, offBest: 0, probes: 0, cuts: 0 };

/** The best move by the search; `temperature` > 0 samples moves by softmax of their values instead. */
export function chooseExtreme(net: Evaluator, state: GameState, rng: Rng, opts?: SearchOptions, temperature = 0): Move {
  if (state.moves.length === 1) return state.moves[0]!;
  const vals = searchValues(net, state, opts);
  if (temperature > 0) {
    const top = Math.max(...vals.map((x) => x.value));
    const w = vals.map((x) => Math.exp((x.value - top) / temperature));
    let r = rng() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < w.length; i++) {
      if ((r -= w[i]!) <= 0) {
        searchStats.sampled++;
        if (vals[i]!.value < top) searchStats.offBest++;
        return vals[i]!.move;
      }
    }
  }
  let best = vals[0]!;
  for (const x of vals) if (x.value + rng() * 1e-9 > best.value) best = x;
  return best.move;
}
