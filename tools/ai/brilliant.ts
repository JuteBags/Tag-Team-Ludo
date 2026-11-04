// Brilliant-move research (#100), run on the owner's molab box in short resumable calls.
// Self-play games with the app's engine (race:128 for Extreme, the app's dice, fixed seeds). At every real
// decision of the side under study it logs a review ladder (16..256 playouts, at two seeds), so n* (the
// smallest playout count from which a move is and stays the best) can be scored offline, plus every
// candidate's gap and SE at 256, the move played and the Hard bot's pick (idea 2).
//   node tools/ai/dist/brilliant.mjs --layout 2p --study extreme|first|normal --games 8 --from 1
//     --worker 0 --workers 8 --out DIR [--until EPOCH_MS]
// Resumable: each worker keeps its game in progress (its record's events) in DIR/<tag>-w<k>.state.json and stops
// at --until; the next call replays the events (no engine calls) and carries on. One JSON line per decision in
// DIR/<tag>-w<k>.jsonl. study: extreme = every seat Extreme, every seat logged (a strong player); first = seat 0
// always plays its first legal move; normal = seat 0 is the Normal bot (the others Extreme; only seat 0 logged).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createGame, move, moveEvent, replay, roll, rollEvent, seeded, seededDie, type GameRecord, type GameState, type Move, type Seat } from '../../src/engine';
import { chooseBotMove } from '../../src/engine/ai/levels';
import type { NetJSON } from '../../src/engine/ai/net';
import { PLAYOUT_RULES } from '../../src/engine/ai/playout-rules';
import { RolloutEngine } from '../../src/engine/ai/rollout';
import { flags, MODES } from './common';

const a = flags(process.argv.slice(2));
const layout = a.layout ?? '2p';
const study = (a.study ?? 'extreme') as 'extreme' | 'first' | 'normal';
const games = Number(a.games ?? 8);
const from = Number(a.from ?? 1);
const worker = Number(a.worker ?? 0);
const workers = Number(a.workers ?? 1);
const out = a.out ?? '.';
const until = Number(a.until ?? Infinity);
const tag = `${layout}-${study}-${from}`;
const LADDER = [16, 32, 48, 64, 96, 128, 256];

const root = new URL('../../../', import.meta.url);
const wasm = readFileSync(new URL('src/engine/ai/ludo_wasm.wasm', root));
const net = JSON.parse(readFileSync(new URL('src/engine/ai/extreme-net.json', root), 'utf8')) as NetJSON;
const engine = await RolloutEngine.create(wasm, net, PLAYOUT_RULES);

const statePath = `${out}/${tag}-w${worker}.state.json`;
const dumpPath = `${out}/${tag}-w${worker}.jsonl`;
type State = { done: number[]; cur: { seed: number; events: string } | null };
const st: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { done: [], cur: null };
const save = () => writeFileSync(statePath, JSON.stringify(st));

const mine = Array.from({ length: games }, (_, g) => from + g).filter((_, g) => g % workers === worker);
const seatsFor = (): Seat[] =>
  MODES[layout]!.seats().map((s) => ({ ...s, bot: true, level: study !== 'extreme' && s.owner === 0 ? 'normal' : 'extreme' }));
const logged = (s: GameState) => study === 'extreme' || s.players[s.current]!.owner === 0;
/** The move index of a review's best candidate. */
const bestIndex = (ofMove: number[], best: number) => ofMove.indexOf(best);

let stopped = false;
for (const seed of mine) {
  if (st.done.includes(seed)) continue;
  const seats = seatsFor();
  const first = seats[seed % seats.length]!.color;
  let events = st.cur?.seed === seed ? st.cur.events : '';
  const rec = (): GameRecord => ({ v: 1, seats, first, singles: MODES[layout]!.singles || undefined, seed, events });
  let s: GameState = events ? replay(rec()).states.at(-1)! : createGame(seats, first, MODES[layout]!.singles);
  for (let n = events.length; s.phase !== 'over' && n < 40000; n++) {
    if (Date.now() > until) {
      st.cur = { seed, events };
      save();
      stopped = true;
      break;
    }
    if (s.phase === 'roll') {
      const f = seededDie(seed, s);
      events += rollEvent(f);
      s = roll(s, () => 0, f);
      continue;
    }
    const p = s.players[s.current]!;
    // Each decision's own stream: a game resumed after a deadline plays exactly as one run straight through.
    const rng = seeded((seed * 1000003 + n * 7919) >>> 0);
    const weak = study !== 'extreme' && p.owner === 0;
    const play: Move = weak ? (study === 'first' ? s.moves[0]! : chooseBotMove(s, rng)) : engine.choose(s, 128, seed * 100003 + n);
    if (logged(s) && s.moves.length > 1) {
      const sa = (seed * 7919 + n) >>> 0;
      const sb = (sa ^ 0x9e3779b9) >>> 0;
      const ref = engine.review(s, 256, sa);
      if (new Set(ref.ofMove).size > 1) {
        const ladder = (sd: number) =>
          LADDER.map((k) => {
            const v = k === 256 && sd === sa ? ref : engine.review(s, k, sd);
            return bestIndex(v.ofMove, v.best);
          });
        const asHard = { ...s, players: s.players.map((x, i) => (i === s.current ? { ...x, level: 'hard' as const } : x)) };
        const hard = s.moves.indexOf(chooseBotMove(asHard, rng));
        const line = {
          layout, study, seed, n, owner: p.owner, color: p.color, moves: s.moves.length, of: ref.ofMove,
          gap: ref.gap.map((x) => +(100 * x).toFixed(2)), se: ref.se.map((x) => +(100 * x).toFixed(2)), mean: ref.mean.map((x) => +x.toFixed(4)),
          best: bestIndex(ref.ofMove, ref.best), played: s.moves.indexOf(play), hard, ladder: { a: ladder(sa), b: ladder(sb) }, at: LADDER,
          events: events.length,
        };
        appendFileSync(dumpPath, JSON.stringify(line) + '\n');
      }
    }
    events += moveEvent(play);
    s = move(s, play);
  }
  if (stopped) break;
  st.done.push(seed);
  st.cur = null;
  save();
}
console.log(`BRILL ${tag} w${worker}: ${st.done.length}/${mine.length} games done${stopped ? ', stopped at the deadline' : ''}`);
