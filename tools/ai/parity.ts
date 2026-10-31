// Parity: the TypeScript net (src/engine/ai/net.ts) must score people exactly as torch did.
//   node parity.mjs --net net.json   (reads net.json.parity-{x,o,s}.npy written by train.py)
// x: inputs [N,4,D]; o: each colour's owner [N,4] (-1 for no colour); s: people's scores [N,4] (NaN for
// nobody). Prints PARITY {positions, max, rel, ok}; ok needs every score within 1e-5 of torch's, relative to
// the score's size (1 + |score|): torch trains in float32, so large linear weights round at about 1e-7 of the sum.
import { readFileSync } from 'node:fs';
import { D } from '../../src/engine/ai/encode';
import { F, FEATURES } from '../../src/engine/ai/features';
import { TURN_RULES, type LinearJSON } from '../../src/engine/ai/linear';
import { Net, type NetJSON } from '../../src/engine/ai/net';
import { flags } from './common';

/** A little-endian float32 or float64 .npy file: its shape and its numbers as float64. */
function npy(path: string): { shape: number[]; data: Float64Array } {
  const b = readFileSync(path);
  const len = b.readUInt16LE(8);
  const head = b.subarray(10, 10 + len).toString('latin1');
  const shape = head.match(/\(([^)]*)\)/)![1]!.split(',').filter((s) => s.trim()).map(Number);
  const body = b.buffer.slice(b.byteOffset + 10 + len, b.byteOffset + b.length);
  const data = head.includes("'<f4'") ? Float64Array.from(new Float32Array(body)) : new Float64Array(body);
  return { shape, data };
}

const a = flags(process.argv.slice(2));
const json = JSON.parse(readFileSync(a.net!, 'utf8')) as NetJSON | LinearJSON;
// Linear rules: a person's score is the weights times the sum of their colours' hand features.
// Weights by input index: the hand features first, the turn rules over encode.ts's last 7 inputs.
const linear = 'kind' in json && json.kind === 'linear'
  ? [...FEATURES.map((f) => json.weights[f] ?? 0), ...new Array<number>(D - F - TURN_RULES.length).fill(0), ...TURN_RULES.map((f) => json.weights[f] ?? 0)]
  : null;
const net = linear ? null : new Net(json as NetJSON);
function linearScores(x: Float64Array, base: number, owners: number[]): Float64Array {
  const s = new Float64Array(4).fill(NaN);
  owners.forEach((o, i) => {
    let v = 0;
    for (let k = 0; k < D; k++) if (linear![k]) v += linear![k]! * x[base + i * D + k]!;
    s[o] = (Number.isNaN(s[o]!) ? 0 : s[o]!) + v;
  });
  return s;
}
const x = npy(`${a.net}.parity-x.npy`);
const o = npy(`${a.net}.parity-o.npy`);
const s = npy(`${a.net}.parity-s.npy`);
const n = x.shape[0]!;
let max = 0;
let rel = 0;
for (let i = 0; i < n; i++) {
  const owners = Array.from(o.data.subarray(i * 4, i * 4 + 4)).filter((v) => v >= 0);
  const got = net ? net.ownerScores(x.data, i * 4 * D, owners, 4) : linearScores(x.data, i * 4 * D, owners);
  for (let p = 0; p < 4; p++) {
    const want = s.data[i * 4 + p]!;
    if (Number.isNaN(want)) continue;
    max = Math.max(max, Math.abs(got[p]! - want));
    rel = Math.max(rel, Math.abs(got[p]! - want) / (1 + Math.abs(want)));
  }
}
console.log(`PARITY ${JSON.stringify({ positions: n, max, rel, ok: rel < 1e-5 })}`);
