// Self-play worker: plays games and writes one shard of training positions (one per turn start).
//   node selfplay.mjs --games 2000 --seed 7 --out shard.bin --pool hard:6,normal:2,easy:1,random:1
//                     [--modes 2p,3p,4p,2p-singles,...] [--keep 0.1] [--commit <sha>]
// --keep is the chance each turn start is written (all of them with 1; a whole game is ~200-600 turns).
// Each person's policy is drawn from the pool by weight. Shard layout: u32 header length, the header as
// JSON (games with their finishing orders and policies), then float32 inputs (positions x 4 x D, unused
// colours 0) and int32 meta (positions x 4: game, turn, colours, current).
import { writeFileSync } from 'node:fs';
import { finalRanking, seeded } from '../../src/engine';
import { D, encodeState } from '../../src/engine/ai/encode';
import { MODES, flags, peopleIn, playGame, policy } from './common';

const a = flags(process.argv.slice(2));
const games = Number(a.games ?? 1000);
const seed = Number(a.seed ?? 1);
const keep = Number(a.keep ?? 0.1);
const modes = (a.modes ?? Object.keys(MODES).join(',')).split(',');
const pool = (a.pool ?? 'hard:1').split(',').map((x) => {
  const i = x.lastIndexOf(':');
  return { spec: x.slice(0, i), w: Number(x.slice(i + 1)) };
});
const total = pool.reduce((s, p) => s + p.w, 0);
function pick(r: number): string {
  for (const p of pool) if ((r -= p.w / total) < 0) return p.spec;
  return pool[pool.length - 1]!.spec;
}

const xs: Float32Array[] = [];
const meta: number[] = [];
const header = { D, commit: a.commit ?? '', seed, keep, games: [] as unknown[] };
const t0 = Date.now();
for (let g = 0; g < games; g++) {
  const gameSeed = seed * 1_000_003 + g;
  const rng = seeded(gameSeed);
  const mode = modes[g % modes.length]!;
  const specs = Array.from({ length: peopleIn(mode) }, () => pick(rng()));
  let turn = 0;
  // A separate stream decides what is kept, so --keep never changes how the game plays out.
  const keepRng = seeded(gameSeed ^ 0x5bd1e995);
  const end = playGame(mode, specs.map(policy), rng, Math.floor(rng() * 4), (s) => {
    if (keepRng() >= keep) return void turn++;
    const x = new Float32Array(4 * D);
    x.set(encodeState(s));
    xs.push(x);
    meta.push(g, turn++, s.players.length, s.current);
  });
  const order = finalRanking(end).map((c) => end.players.findIndex((p) => p.color === c));
  header.games.push({ seed: gameSeed, mode, owners: end.players.map((p) => p.owner), order, policies: specs, over: end.phase === 'over', turns: turn });
  if ((g + 1) % 500 === 0) console.log(`PROGRESS ${g + 1}/${games} ${(((g + 1) * 1000) / (Date.now() - t0)).toFixed(1)} games/s`);
}

const head = new TextEncoder().encode(JSON.stringify(header));
const X = new Float32Array(xs.length * 4 * D);
xs.forEach((x, i) => X.set(x, i * 4 * D));
const M = Int32Array.from(meta);
const buf = new Uint8Array(4 + head.length + X.byteLength + M.byteLength);
new DataView(buf.buffer).setUint32(0, head.length, true);
buf.set(head, 4);
buf.set(new Uint8Array(X.buffer), 4 + head.length);
buf.set(new Uint8Array(M.buffer), 4 + head.length + X.byteLength);
writeFileSync(a.out ?? 'shard.bin', buf);
console.log(`DONE ${games} games ${xs.length} positions ${((games * 1000) / (Date.now() - t0)).toFixed(1)} games/s`);
