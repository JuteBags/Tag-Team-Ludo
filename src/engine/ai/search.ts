// Extreme: expectimax over whole turns, max^n for several players, with the value net at the leaves.
// A turn is planned whole: every order of playing the tray's dice, with any extra roll (after a 6, a
// kill or a token home) as a chance node. At depth 2 the next player's turn follows, and they play the
// way the net thinks is best for THEM (max^n: each player maximises their own chance), not worst-case
// for me. Every face counts 1 in 6: the engine assumes fair dice, like the people playing it.
import { scoreMove } from '../bot';
import { move, ownerRanking, roll } from '../game';
import type { GameState, Move, Rng } from '../types';
import type { Net } from './net';

export interface SearchOptions {
  /** Turns looked at: 1 = my turn only, 2 = also the next player's, and so on. */
  depth?: number;
  /** Chance nodes allowed within one turn before the value takes over. */
  chance?: number;
  /** Moves other players consider at each decision, best first by the Hard rules (0 = all). */
  theirK?: number;
}

const FACES = [1, 2, 3, 4, 5, 6];
const noRng: Rng = () => 0.5;
const key = (s: GameState) => `${s.current}|${s.phase}|${s.sixes}|${s.rolls.join('')}|${s.players.map((p) => p.tokens.join(',')).join(';')}`;

/** Each person's chance of winning, by owner. */
export function ownerValues(net: Net, s: GameState, owners: number): Float64Array {
  if (s.phase === 'over') {
    const v = new Float64Array(owners);
    v[ownerRanking(s)[0]!] = 1;
    return v;
  }
  return net.ownerChances(s);
}

/** The search's value of each of the current player's moves, as that player's chance of winning. */
export function searchValues(net: Net, state: GameState, opts: SearchOptions = {}): { move: Move; value: number }[] {
  const depth = opts.depth ?? 1;
  const maxChance = opts.chance ?? 2;
  const theirK = opts.theirK ?? 3;
  const owners = Math.max(...state.players.map((p) => p.owner)) + 1;
  const root = state.current;
  const memo = new Map<string, Float64Array>();
  const rootOwner = state.players[root]!.owner;

  // `turnsLeft` counts the turns still to search, this one included; `who` is whose turn it is.
  function node(s: GameState, who: number, turnsLeft: number, chance: number): Float64Array {
    if (s.phase === 'over') return ownerValues(net, s, owners);
    if (s.current !== who) return turnsLeft > 1 ? node(s, s.current, turnsLeft - 1, 0) : ownerValues(net, s, owners);
    const k = `${key(s)}|${turnsLeft}|${chance}`;
    const hit = memo.get(k);
    if (hit) return hit;
    let v: Float64Array;
    if (s.phase === 'move') {
      const me = s.players[who]!.owner;
      let moves = s.moves;
      if (me !== rootOwner && theirK > 0 && moves.length > theirK) moves = [...moves].sort((a, b) => scoreMove(s, b) - scoreMove(s, a)).slice(0, theirK);
      v = new Float64Array(owners).fill(-1);
      for (const m of moves) {
        const c = node(move(s, m), who, turnsLeft, chance);
        if (c[me]! > v[me]!) v = c;
      }
    } else if (chance >= maxChance) {
      v = ownerValues(net, s, owners);
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

  const me = state.players[root]!.owner;
  return state.moves.map((m) => ({ move: m, value: node(move(state, m), root, depth, 0)[me]! }));
}

/** The best move by the search; `temperature` > 0 samples moves by softmax of their values instead. */
export function chooseExtreme(net: Net, state: GameState, rng: Rng, opts?: SearchOptions, temperature = 0): Move {
  if (state.moves.length === 1) return state.moves[0]!;
  const vals = searchValues(net, state, opts);
  if (temperature > 0) {
    const top = Math.max(...vals.map((x) => x.value));
    const w = vals.map((x) => Math.exp((x.value - top) / temperature));
    let r = rng() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < w.length; i++) if ((r -= w[i]!) <= 0) return vals[i]!.move;
  }
  let best = vals[0]!;
  for (const x of vals) if (x.value + rng() * 1e-9 > best.value) best = x;
  return best.move;
}
