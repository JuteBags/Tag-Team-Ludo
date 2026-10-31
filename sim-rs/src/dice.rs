//! dice.ts: analyzeDice + sampleFace, same rng draws and the same f64 operations in the same order.
use crate::rng::Rng;
use crate::rules::{is_escape, legal_moves, Board, MoveList};

const BASE_W: f64 = 3.0;
const MIN_W: f64 = 2.0;
const MAX_W: f64 = 5.0;
const MAX_BOOSTED: usize = 2;

/// Fisher-Yates from the end, j = floor(rng * (i + 1)).
fn shuffle(a: &mut [u8], rng: &mut Rng) {
    let mut i = a.len();
    while i > 1 {
        i -= 1;
        let j = (rng.next() * (i as f64 + 1.0)).floor() as usize;
        a.swap(i, j);
    }
}

/// `w.reduce((a, b) => a + b, 0)`
#[inline]
fn sum(w: &[f64; 6]) -> f64 {
    let mut s = 0.0;
    for &x in w {
        s += x;
    }
    s
}

fn rebalance(w: &mut [f64; 6], faces: &[usize]) {
    let diff = sum(w) - 18.0;
    for &i in faces {
        w[i] -= diff / faces.len() as f64;
    }
}

/// Probability of each face 1-6 for `color`'s next roll.
pub fn weights(b: &Board, color: u8, rng: &mut Rng, singles: bool, ml: &mut MoveList) -> [f64; 6] {
    let mut kill = [0u8; 6];
    let mut nk = 0;
    let mut escape = [0u8; 6];
    let mut ne = 0;
    let mut finish = [false; 7];
    for f in 1..=6u8 {
        ml.clear();
        legal_moves(b, color, f, singles, ml);
        let moves = ml.as_slice();
        if moves.iter().any(|m| m.ncap > 0) {
            kill[nk] = f;
            nk += 1;
        }
        if moves.iter().any(|m| is_escape(b, m, singles)) {
            escape[ne] = f;
            ne += 1;
        }
        if moves.iter().any(|m| m.finishes > 0) {
            finish[f as usize] = true;
        }
    }
    let kill = &mut kill[..nk];
    shuffle(kill, rng);
    let mut esc = [0u8; 6];
    let mut n2 = 0;
    for &f in &escape[..ne] {
        if !kill.contains(&f) {
            esc[n2] = f;
            n2 += 1;
        }
    }
    let esc = &mut esc[..n2];
    shuffle(esc, rng);
    let mut boosted = [false; 7];
    let mut nb = 0;
    for &f in kill.iter().chain(esc.iter()) {
        if nb == MAX_BOOSTED {
            break;
        }
        boosted[f as usize] = true;
        nb += 1;
    }

    let mut w = [BASE_W; 6];
    for f in 1..=6 {
        if boosted[f] {
            w[f - 1] += 1.0;
        }
    }
    for f in 1..=6 {
        if finish[f] {
            w[f - 1] -= 1.0;
        }
    }
    let mut faces = [0usize; 6];
    let mut nf = 0;
    for i in 0..6 {
        if !boosted[i + 1] && !finish[i + 1] {
            faces[nf] = i;
            nf += 1;
        }
    }
    if nf > 0 {
        rebalance(&mut w, &faces[..nf]);
    } else {
        rebalance(&mut w, &[0, 1, 2, 3, 4, 5]);
    }
    for _pass in 0..6 {
        for x in w.iter_mut() {
            *x = MAX_W.min(MIN_W.max(*x));
        }
        let diff = sum(&w) - 18.0;
        if diff.abs() < 1e-9 {
            break;
        }
        nf = 0;
        for i in 0..6 {
            if if diff > 0.0 { w[i] > MIN_W } else { w[i] < MAX_W } {
                faces[nf] = i;
                nf += 1;
            }
        }
        rebalance(&mut w, &faces[..nf]);
    }
    let mut out = [0.0; 6];
    for i in 0..6 {
        out[i] = w[i] / 18.0;
    }
    out
}

pub fn sample_face(weights: &[f64; 6], rng: &mut Rng) -> u8 {
    let mut r = rng.next();
    for (i, &w) in weights.iter().enumerate().take(5) {
        r -= w;
        if r < 0.0 {
            return i as u8 + 1;
        }
    }
    6
}

pub fn roll_face(b: &Board, color: u8, rng: &mut Rng, singles: bool, ml: &mut MoveList) -> u8 {
    let w = weights(b, color, rng, singles, ml);
    sample_face(&w, rng)
}
