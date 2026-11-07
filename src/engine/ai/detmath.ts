// Deterministic maths for the bots (#221). Online, every player's app runs the ranked bots and the moves must be
// the same on every device. JavaScript's +, -, * and / are exactly rounded (IEEE 754) everywhere, but Math.exp is
// not specified to the last bit, so Chrome and Safari may differ there and flip a near tie. detExp uses only the
// exact operations: the same input gives the same bits in every engine.

const LN2_HI = 0.6931471803691238; // ln 2 split in two (Cody and Waite), so k * LN2_HI is exact for |k| < 2^11
const LN2_LO = 1.9082149292705877e-10;
const LOG2E = 1.4426950408889634;
// 1/n! for the Taylor series, n = 0..13 (|r| <= 0.35: the error is below one part in 10^16).
const INV_FACT = (() => {
  const out: number[] = [];
  let f = 1;
  for (let n = 0; n <= 13; n++) {
    if (n > 0) f *= n;
    out.push(1 / f);
  }
  return out;
})();

/** 2^k exactly (k an integer; powers of two are exact until they go subnormal). */
function pow2(k: number): number {
  let out = 1;
  const step = k < 0 ? 0.5 : 2;
  let n = Math.abs(k);
  let f = step;
  while (n > 0) {
    if (n & 1) out *= f;
    f *= f;
    n >>= 1;
  }
  return out;
}

/** e^x, the same in every JavaScript engine (within about 1e-16 of Math.exp). */
export function detExp(x: number): number {
  if (x !== x) return NaN;
  if (x > 709) return Infinity;
  if (x < -745) return 0;
  const k = Math.round(x * LOG2E);
  const r = x - k * LN2_HI - k * LN2_LO;
  let p = INV_FACT[13]!;
  for (let n = 12; n >= 0; n--) p = p * r + INV_FACT[n]!;
  // Split the scale so neither factor overflows or underflows on its own near the ends of the range.
  const half = Math.trunc(k / 2);
  return p * pow2(half) * pow2(k - half);
}
