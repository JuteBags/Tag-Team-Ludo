// Parity: the TypeScript net (src/engine/ai/net.ts) must score people exactly as torch did.
//   node parity.mjs --net net.json   (reads net.json.parity-{x,o,s}.npy written by train.py)
// x: inputs [N,4,D]; o: each colour's owner [N,4] (-1 for no colour); s: people's scores [N,4] (NaN for
// nobody). Prints PARITY {positions, max, ok}; ok needs every score within 1e-5 of torch's.
import { readFileSync } from 'node:fs';
import { D } from '../../src/engine/ai/encode';
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
const net = new Net(JSON.parse(readFileSync(a.net!, 'utf8')) as NetJSON);
const x = npy(`${a.net}.parity-x.npy`);
const o = npy(`${a.net}.parity-o.npy`);
const s = npy(`${a.net}.parity-s.npy`);
const n = x.shape[0]!;
let max = 0;
for (let i = 0; i < n; i++) {
  const owners = Array.from(o.data.subarray(i * 4, i * 4 + 4)).filter((v) => v >= 0);
  const got = net.ownerScores(x.data, i * 4 * D, owners, 4);
  for (let p = 0; p < 4; p++) {
    const want = s.data[i * 4 + p]!;
    if (!Number.isNaN(want)) max = Math.max(max, Math.abs(got[p]! - want));
  }
}
console.log(`PARITY ${JSON.stringify({ positions: n, max, ok: max < 1e-5 })}`);
