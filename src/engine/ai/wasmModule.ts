// Which build of the Rust engine to load (#151): the SIMD one (sim-wasm built with +simd128, the net's dense
// layers in f64x2 lanes, every value bit-identical to the plain build) where the browser has WebAssembly SIMD,
// else the plain one. Both are committed and built by .github/workflows/wasm.yml; only the one picked is fetched.
import plainUrl from './ludo_wasm.wasm?url';
import simdUrl from './ludo_wasm_simd.wasm?url';

export type WasmKind = 'simd' | 'plain';

/** The smallest module that uses a SIMD instruction (i8x16.splat, i8x16.popcnt): it validates only with SIMD. */
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

/** A worker named `wasm=plain` (the bench's ?wasm=plain) always loads the plain build. */
export const FORCE_PLAIN = 'wasm=plain';

let picked: WasmKind | undefined;

/** The build this context loads: plain when forced or without SIMD, else SIMD. Decided once. */
export function wasmKind(validate: (b: Uint8Array) => boolean = (b) => WebAssembly.validate(b as BufferSource)): WasmKind {
  if (picked) return picked;
  const forced = (globalThis as { name?: unknown }).name === FORCE_PLAIN;
  let simd = false;
  try {
    simd = !forced && validate(SIMD_PROBE);
  } catch {
    simd = false;
  }
  return (picked = simd ? 'simd' : 'plain');
}

/** The URL of the engine build to fetch. */
export const wasmUrl = (): string => (wasmKind() === 'simd' ? simdUrl : plainUrl);

/** For tests: forget the choice. */
export const resetWasmKind = () => {
  picked = undefined;
};
