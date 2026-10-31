//! src/engine/rng.ts `seeded()`: a mulberry32 variant. u32 wrapping math stands in for JS's `| 0`,
//! `Math.imul` and `>>>`; the output is the u32 / 2^32 as f64, exactly as in JS.

#[derive(Clone, Copy, Debug)]
pub struct Rng {
    a: u32,
}

impl Rng {
    /// `seed | 0` in JS: ToInt32 of the (integral) seed, i.e. its low 32 bits.
    pub fn seeded(seed: i64) -> Self {
        Rng { a: seed as u32 }
    }

    #[inline]
    pub fn next(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b_79f5);
        let a = self.a;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }
}
