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
}
