//! src/engine/ai/features.ts + encode.ts: the value net's inputs, same f64 operations in the same order.
use crate::rules::{is_safe, square_of, Board, BASE, FINISHED, HOME_FIRST, LAST_TRACK, TRACK_LEN};

/// features.ts FEATURES (pipsLeft .. singles).
pub const F: usize = 19;
const BUCKETS: usize = 11;
const PER_TOKEN: usize = BUCKETS + 2;
/// One colour's own raw block.
pub const RAW: usize = 4 * PER_TOKEN;
/// The turn in progress: tray dice per face (/3) and the 6s in a row (/2).
const TURN: usize = 7;
/// Numbers per colour.
pub const D: usize = F + 3 * RAW + TURN;

pub const FEATURE_NAMES: [&str; F] = [
    "pipsLeft", "base", "home", "column", "danger", "dangerProg", "prey", "preyProg", "safe", "blocks", "blocking", "ambush", "maxProg",
    "minProg", "turn0", "turn1", "turn2", "turn3", "singles",
];

#[inline]
fn reach(gap: i32) -> f64 {
    if (1..=6).contains(&gap) {
        1.0 / 6.0
    } else if (7..=12).contains(&gap) {
        1.0 / 36.0
    } else {
        0.0
    }
}

/// features(): every colour's F features, in players order, into out[..n*F].
pub fn features(b: &Board, current: usize, singles: bool, out: &mut [f64]) {
    let n = b.n;
    let ps = b.players();
    // square -> tokens there per colour index (track squares only)
    let mut at = [[0i32; 4]; 52];
    for (i, p) in ps.iter().enumerate() {
        for &t in &p.tokens {
            let sq = square_of(p.color, t);
            if sq >= 0 {
                at[sq as usize][i] += 1;
            }
        }
    }
    let is_double = |sq: i32, i: usize| -> bool {
        let c = at[sq as usize][i];
        !singles && !is_safe(sq) && c >= 2 && c % 2 == 0
    };
    let fin = FINISHED as f64;
    for i in 0..n {
        let p = &ps[i];
        let o = i * F;
        for k in 0..F {
            out[o + k] = 0.0;
        }
        let (mut pips, mut max_p, mut min_p, mut live) = (0i32, 0i32, FINISHED as i32, 0i32);
        for &t in &p.tokens {
            pips += FINISHED as i32 - (t.max(BASE)) as i32;
            if t == BASE {
                out[o + 1] += 0.25;
            } else if t == FINISHED {
                out[o + 2] += 0.25;
            } else if t >= HOME_FIRST {
                out[o + 3] += 0.25;
            }
            if t != FINISHED {
                live += 1;
                max_p = max_p.max(t as i32 + 1);
                min_p = min_p.min(t as i32 + 1);
            }
        }
        out[o] = pips as f64 / (4 * (FINISHED as i32 + 1)) as f64;
        out[o + 12] = max_p as f64 / fin;
        out[o + 13] = if live != 0 { min_p as f64 / fin } else { 1.0 };

        let mut seen = 0u64;
        for &t in &p.tokens {
            let sq = square_of(p.color, t);
            if sq < 0 || (seen >> sq) & 1 == 1 {
                continue;
            }
            seen |= 1 << sq;
            let mine = at[sq as usize][i] as f64;
            if is_safe(sq) {
                out[o + 8] += mine / 4.0;
                let mut behind = false;
                let mut j = 0;
                while j < n && !behind {
                    if j != i && ps[j].owner != p.owner {
                        for &e in &ps[j].tokens {
                            let es = square_of(ps[j].color, e);
                            if es < 0 {
                                continue;
                            }
                            let gap = (sq - es + TRACK_LEN) % TRACK_LEN;
                            if (1..=12).contains(&gap) && e as i32 + gap <= LAST_TRACK as i32 {
                                behind = true;
                            }
                        }
                    }
                    j += 1;
                }
                if behind {
                    out[o + 11] += mine / 4.0;
                }
                continue;
            }
            let dbl = is_double(sq, i);
            if dbl {
                out[o + 9] += mine / 4.0;
            }
            let mut safe_p = 1.0f64;
            for j in 0..n {
                if j == i || ps[j].owner == p.owner {
                    continue;
                }
                let q = &ps[j];
                let mut counted = 0u64;
                for &e in &q.tokens {
                    let es = square_of(q.color, e);
                    if es < 0 || (counted >> es) & 1 == 1 {
                        continue;
                    }
                    counted |= 1 << es;
                    let gap = (sq - es + TRACK_LEN) % TRACK_LEN;
                    if e as i32 + gap > LAST_TRACK as i32 {
                        continue;
                    }
                    if dbl {
                        if is_double(es, j) && (1..=3).contains(&gap) {
                            safe_p *= 5.0 / 6.0;
                        }
                    } else {
                        safe_p *= 1.0 - reach(gap);
                    }
                    if dbl && (1..=6).contains(&gap) {
                        out[o + 10] += at[es as usize][j] as f64 / 4.0;
                    }
                }
            }
            let hit = 1.0 - safe_p;
            out[o + 4] += hit * (mine / 4.0);
            out[o + 5] += hit * (mine / 4.0) * ((t as i32 + 1) as f64 / fin);
            for j in 0..n {
                if j == i || ps[j].owner == p.owner {
                    continue;
                }
                let q = &ps[j];
                for &e in &q.tokens {
                    let es = square_of(q.color, e);
                    if es < 0 || is_safe(es) || is_double(es, j) {
                        continue;
                    }
                    let gap = (es - sq + TRACK_LEN) % TRACK_LEN;
                    if t as i32 + gap > LAST_TRACK as i32 {
                        continue;
                    }
                    let r = reach(gap);
                    out[o + 6] += r;
                    out[o + 7] += r * ((e as i32 + 1) as f64 / fin);
                }
            }
        }
        out[o + 14 + (i + n - current) % n] = 1.0;
        out[o + 18] = if singles { 1.0 } else { 0.0 };
    }
}

#[inline]
fn bucket(t: i8) -> usize {
    if t == BASE {
        0
    } else if t == FINISHED {
        10
    } else if t >= HOME_FIRST {
        9
    } else {
        1 + 7usize.min((t as f64 / 6.375).floor() as usize)
    }
}

fn nearest(b: &Board, me: usize, sq: i32, dir: i32) -> f64 {
    let ps = b.players();
    let mut best = 13;
    for q in ps {
        if q.owner == ps[me].owner {
            continue;
        }
        for &e in &q.tokens {
            let es = square_of(q.color, e);
            if es < 0 {
                continue;
            }
            let d = ((if dir == 1 { es - sq } else { sq - es }) + TRACK_LEN) % TRACK_LEN;
            if d >= 1 && d < best {
                best = d;
            }
        }
    }
    if best <= 12 {
        (13 - best) as f64 / 12.0
    } else {
        0.0
    }
}

fn raw_block(b: &Board, i: usize, out: &mut [f64]) {
    let p = &b.p[i];
    let mut sorted = p.tokens;
    sorted.sort();
    for x in out.iter_mut().take(RAW) {
        *x = 0.0;
    }
    for (k, &t) in sorted.iter().enumerate() {
        let o = k * PER_TOKEN;
        out[o + bucket(t)] = 1.0;
        if (0..=LAST_TRACK).contains(&t) {
            let sq = square_of(p.color, t);
            out[o + BUCKETS] = nearest(b, i, sq, -1);
            out[o + BUCKETS + 1] = nearest(b, i, sq, 1);
        }
    }
}

/// encode(): players.length * D numbers into out (cleared first), each colour's net input.
pub fn encode(b: &Board, current: usize, singles: bool, rolls: &[u8], sixes: u8, out: &mut [f64]) {
    let n = b.n;
    let mut hand = [0.0f64; 4 * F];
    features(b, current, singles, &mut hand);
    let mut raw = [0.0f64; 4 * RAW];
    for i in 0..n {
        raw_block(b, i, &mut raw[i * RAW..(i + 1) * RAW]);
    }
    for x in out.iter_mut().take(n * D) {
        *x = 0.0;
    }
    let ps = b.players();
    for i in 0..n {
        let o = i * D;
        out[o..o + F].copy_from_slice(&hand[i * F..(i + 1) * F]);
        out[o + F..o + F + RAW].copy_from_slice(&raw[i * RAW..(i + 1) * RAW]);
        for j in 0..n {
            if ps[j].owner == ps[i].owner {
                continue;
            }
            for k in 0..RAW {
                let v = raw[j * RAW + k];
                out[o + F + RAW + k] += v;
                // Math.max(a, v): both finite and >= 0 here, so f64::max agrees
                out[o + F + 2 * RAW + k] = out[o + F + 2 * RAW + k].max(v);
            }
        }
    }
    let t = current * D + F + 3 * RAW;
    for &r in rolls {
        out[t + r as usize - 1] += 1.0 / 3.0;
    }
    out[t + 6] = sixes as f64 / 2.0;
}
