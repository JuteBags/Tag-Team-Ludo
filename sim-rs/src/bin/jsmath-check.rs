//! Checks jsmath::exp / tanh against Node's Math.exp / Math.tanh bit for bit.
//!   node jsmath_ref.mjs ref.txt && jsmath-check ref.txt
fn main() {
    let path = std::env::args().nth(1).expect("ref file");
    let text = std::fs::read_to_string(path).unwrap();
    let (mut n, mut bad_e, mut bad_t) = (0, 0, 0);
    for line in text.lines() {
        let v: Vec<u64> = line.split(' ').map(|h| u64::from_str_radix(h, 16).unwrap()).collect();
        let x = f64::from_bits(v[0]);
        if ludo_sim::jsmath::exp(x).to_bits() != v[1] {
            if bad_e < 5 { eprintln!("exp({x:e}) rust {:e} js {:e}", ludo_sim::jsmath::exp(x), f64::from_bits(v[1])); }
            bad_e += 1;
        }
        if ludo_sim::jsmath::tanh(x).to_bits() != v[2] {
            if bad_t < 5 { eprintln!("tanh({x:e}) rust {:e} js {:e}", ludo_sim::jsmath::tanh(x), f64::from_bits(v[2])); }
            bad_t += 1;
        }
        n += 1;
    }
    println!("JSMATH n {n} exp mismatches {bad_e} tanh mismatches {bad_t}");
    // tanh4 (AVX2) against scalar tanh: the reference inputs plus a wide random sweep
    #[cfg(target_arch = "x86_64")]
    if std::is_x86_feature_detected!("avx2") {
        let mut xs: Vec<f64> = text.lines().map(|l| f64::from_bits(u64::from_str_radix(l.split(' ').next().unwrap(), 16).unwrap())).collect();
        let mut s = 12345u64;
        for _ in 0..4_000_000 {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let u = (s >> 11) as f64 / (1u64 << 53) as f64;
            let e = ((s >> 3) % 40) as i32 - 30;
            xs.push((u - 0.5) * 2f64.powi(e));
        }
        for i in 0..100_000 {
            xs.push(i as f64 * 0.0005 - 25.0);
        }
        let mut bad = 0;
        for c in xs.chunks(4) {
            if c.len() < 4 {
                break;
            }
            let mut v = [c[0], c[1], c[2], c[3]];
            unsafe { ludo_sim::simd::tanh4(&mut v) };
            for j in 0..4 {
                if v[j].to_bits() != ludo_sim::jsmath::tanh(c[j]).to_bits() {
                    if bad < 5 {
                        eprintln!("tanh4({:e}) {:e} vs {:e}", c[j], v[j], ludo_sim::jsmath::tanh(c[j]));
                    }
                    bad += 1;
                }
            }
        }
        println!("TANH4 n {} mismatches {bad}", xs.len());
    }
}
