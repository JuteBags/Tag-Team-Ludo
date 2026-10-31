// Parity: the TypeScript net (src/engine/ai/net.ts) must score positions exactly as torch did.
//   node parity.mjs --net net.json   (reads net.json.parity-x.npy and net.json.parity-s.npy from train.py)
// Prints PARITY {max, ok}; ok needs every score within 1e-4 of torch's (float32 training, float64 here).
import { readFileSync } from 'node:fs';
import { D } from '../../src/engine/ai/encode';
import { Net, type NetJSON } from '../../src/engine/ai/net';
import { flags } from './common';

/** A little-endian .npy file: its shape and its numbers as float64. */
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
const s = npy(`${a.net}.parity-s.npy`);
const [n] = x.shape;
let max = 0;
for (let i = 0; i < n!; i++) {
  for (let c = 0; c < 4; c++) max = Math.max(max, Math.abs(net.score(x.data, (i * 4 + c) * D) - s.data[i * 4 + c]!));
}
console.log(`PARITY ${JSON.stringify({ positions: n, max, ok: max < 1e-4 })}`);
