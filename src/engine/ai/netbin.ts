// The value net as binary (#98): extreme-net.bin, made from extreme-net.json (the training output, still the
// source of truth) by encodeNet, and checked by tests/netBin.test.ts to equal it byte for byte. The app
// fetches it instead of importing the JSON as a 560 kB JS literal: no JS parse, no re-stringify for the
// WebAssembly engine, one copy shared by the worker and the main thread.
// Little-endian, the weights as Float64 (exactly the doubles JSON.parse gives, so every value is the same):
//   "LNET", u32 version (1), u32 inputs, u32 index per input, u32 trunk layers, then per layer (trunk...,
//   pool, out): u32 out, u32 in, f64 W row by row (out x in), f64 b (out).
// sim-rs eval.rs Evaluator::from_bin reads the same layout.
import type { NetJSON } from './net';

const MAGIC = 0x54454e4c; // "LNET" read as a little-endian u32
const VERSION = 1;

interface Dense {
  W: number[][];
  b: number[];
}

/** extreme-net.json's net as extreme-net.bin's bytes. */
export function encodeNet(net: NetJSON): Uint8Array {
  const layers: Dense[] = [...net.trunk, net.pool, net.out];
  let size = 4 * (4 + net.inputs.length);
  for (const l of layers) size += 8 + 8 * (l.b.length * l.W[0]!.length + l.b.length);
  const v = new DataView(new ArrayBuffer(size));
  let o = 0;
  const u32 = (x: number) => (v.setUint32(o, x, true), (o += 4));
  const f64 = (x: number) => (v.setFloat64(o, x, true), (o += 8));
  u32(MAGIC);
  u32(VERSION);
  u32(net.inputs.length);
  net.inputs.forEach(u32);
  u32(net.trunk.length);
  for (const l of layers) {
    u32(l.b.length);
    u32(l.W[0]!.length);
    for (const row of l.W) row.forEach(f64);
    l.b.forEach(f64);
  }
  return new Uint8Array(v.buffer);
}

/** One layer as the net computes with it: W row by row (out x in), and b. */
export interface BinLayer {
  W: Float64Array;
  b: Float64Array;
  out: number;
  inn: number;
}

export interface BinNet {
  inputs: Int32Array;
  trunk: BinLayer[];
  pool: BinLayer;
  out: BinLayer;
}

/** extreme-net.bin's bytes as the net's layers (typed arrays, no JSON). */
export function decodeNet(bytes: ArrayBuffer | Uint8Array): BinNet {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = 0;
  const u32 = () => ((o += 4), v.getUint32(o - 4, true));
  const f64s = (n: number) => {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = v.getFloat64(o + 8 * i, true);
    o += 8 * n;
    return a;
  };
  if (u32() !== MAGIC) throw new Error('not a net file');
  const version = u32();
  if (version !== VERSION) throw new Error(`net file version ${version}, expected ${VERSION}`);
  const inputs = Int32Array.from({ length: u32() }, () => u32());
  const nt = u32();
  const layer = (): BinLayer => {
    const out = u32();
    const inn = u32();
    return { W: f64s(out * inn), b: f64s(out), out, inn };
  };
  const trunk = Array.from({ length: nt }, layer);
  const pool = layer();
  const out = layer();
  if (o !== u8.byteLength) throw new Error('net file has trailing bytes');
  return { inputs, trunk, pool, out };
}
