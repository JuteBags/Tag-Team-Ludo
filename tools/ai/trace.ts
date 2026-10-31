// Parity traces: what the TypeScript engine does, step by step, for ports of the rules (Rust, GPU) to
// reproduce exactly.
//   node trace.mjs --games 1000 --seed 1 --out traces.jsonl [--from 0] [--full] [--modes 2p,4p,...]
//                  [--policies random,easy,normal,hard]
// Format 2 (common.ts FORMAT): the dice draw from diceRngFor(gameSeed), the policies from rng.
// Games g = from .. from + games - 1 (--from lets workers split one seed). Game g: rng = seeded(seed * 1_000_003 + g), mode = modes[g % modes], the person at owner o plays
// policies[(g + o) % policies], the colour at index g % colours starts. One JSON line per game:
// {g, seed, mode, first, policies, steps, ranking, hash}; with --full also `trace`, the list of steps.
// A step is the state before it, then what happened:
//   state  = current|phase|tray|sixes|tokens   (tokens: each colour's 4 progress values, colours by ';')
//   roll   = R<face>
//   move   = M<chosen>/<every legal move, in the engine's order, by ','>
//            (order matters: the bots' tie-break and the random picks draw from the rng in this order)
//   a move = <kind initial><colour initial><token indices>:<from>><to>d<die>x<captured colour+token...>
// hash is FNV-1a (32-bit) over every step line joined by '\n', so millions of games compare cheaply.
import { writeFileSync } from 'node:fs';
import { analyzeDice, createGame, move, ownerRanking, roll, sampleFace, seeded, type GameState, type Move } from '../../src/engine';
import { FORMAT, MODES, diceRngFor, flags, policy, rollFace, type DiceMode } from './common';

const a = flags(process.argv.slice(2));
const games = Number(a.games ?? 1000);
const from = Number(a.from ?? 0);
const seed = Number(a.seed ?? 1);
const full = 'full' in a;
const modes = (a.modes ?? Object.keys(MODES).join(',')).split(',');
const policies = (a.policies ?? 'random,easy,normal,hard').split(',');
// --dice fair: every face 1 in 6; default: the app's dice.
const diceMode = (a.dice ?? 'game') as DiceMode;

export const stateKey = (s: GameState) =>
  `${s.current}|${s.phase}|${s.rolls.join('')}|${s.sixes}|${s.players.map((p) => p.tokens.join(',')).join(';')}`;
export const moveKey = (m: Move) =>
  `${m.kind[0]}${m.color[0]}${m.tokens.join('')}:${m.from}>${m.to}d${m.roll}x${m.captures.map((c) => `${c.color[0]}${c.token}`).join('')}`;

function fnv1a(text: string, h = 0x811c9dc5): number {
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

const lines: string[] = [];
const t0 = Date.now();
for (let g = from; g < from + games; g++) {
  const gameSeed = seed * 1_000_003 + g;
  const rng = seeded(gameSeed);
  const dice = diceRngFor(gameSeed);
  const mode = modes[g % modes.length]!;
  const m = MODES[mode]!;
  let s = createGame(m.seats(), undefined, m.singles);
  const people = Math.max(...s.players.map((p) => p.owner)) + 1;
  const specs = Array.from({ length: people }, (_, o) => policies[(g + o) % policies.length]!);
  const byOwner = specs.map(policy);
  const first = g % s.players.length;
  s = { ...s, current: first };
  const trace: string[] = [];
  let h = 0x811c9dc5;
  const step = (line: string) => {
    if (full) trace.push(line);
    h = fnv1a(line + '\n', h);
  };
  let steps = 0;
  for (; s.phase !== 'over' && steps < 50000; steps++) {
    const before = stateKey(s);
    if (s.phase === 'roll') {
      const face = rollFace(s, dice, diceMode);
      step(`${before} R${face}`);
      s = roll(s, dice, face);
    } else {
      const chosen = byOwner[s.players[s.current]!.owner]!(s, rng);
      step(`${before} M${moveKey(chosen)}/${s.moves.map(moveKey).join(',')}`);
      s = move(s, chosen);
    }
  }
  const ranking = ownerRanking(s);
  step(`${stateKey(s)} END${ranking.join('')}`);
  lines.push(JSON.stringify({ v: FORMAT, ...(diceMode === 'fair' ? { dice: 'fair' } : {}), g, seed: gameSeed, mode, first, policies: specs, steps, ranking, hash: h.toString(16).padStart(8, '0'), ...(full ? { trace } : {}) }));
}
writeFileSync(a.out ?? 'traces.jsonl', lines.join('\n') + '\n');
console.log(`TRACE ${games} games ${((games * 1000) / (Date.now() - t0)).toFixed(1)} games/s`);
