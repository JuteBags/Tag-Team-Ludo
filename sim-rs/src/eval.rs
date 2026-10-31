//! Position evaluators: linear.ts (readable rules) and net.ts (the value net). Each gives every person
//! their chance of winning; f64 throughout, sums in the TypeScript order, V8's exp/tanh (jsmath).
use crate::encode::{encode, features, D, F, FEATURE_NAMES};
use crate::game::Game;
use crate::jsmath;
use crate::rules::is_done;
use serde_json::Value;

/// A dense layer, weights stored column-major (wt[c * out + r]) so 8 output rows advance together.
/// Each row still sums b[r] + w[r][0] a[0] + w[r][1] a[1] + ... in net.ts's order (lanes are
/// independent rows, no reassociation, no FMA), so every output is bit-identical to the TS.
struct Dense {
    wt: Vec<f64>,
    b: Vec<f64>,
    out: usize,
    inn: usize,
}

const MAXW: usize = 384;

/// NB vectors through one layer at once (all colours of a position, or all people): each weight is
/// loaded once for every vector. Per (vector, row) the sum order is the scalar one.
#[inline(always)]
fn dense_batch_scalar<const NB: usize>(wt: &[f64], b: &[f64], out: usize, cols: &[usize], a: &[[f64; MAXW]], z: &mut [[f64; MAXW]]) {
    for j in 0..NB {
        for r in 0..out {
            let mut s = b[r];
            for &c in cols {
                s += wt[c * out + r] * a[j][c];
            }
            z[j][r] = s;
        }
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn dense_batch_avx2<const NB: usize>(wt: &[f64], b: &[f64], out: usize, cols: &[usize], a: &[[f64; MAXW]], z: &mut [[f64; MAXW]]) {
    use std::arch::x86_64::*;
    let wp = wt.as_ptr();
    let mut r0 = 0;
    // 16 rows x NB vectors per pass: 4*NB independent add chains keep the adders busy
    while r0 + 16 <= out {
        let bb = [
            _mm256_loadu_pd(b.as_ptr().add(r0)),
            _mm256_loadu_pd(b.as_ptr().add(r0 + 4)),
            _mm256_loadu_pd(b.as_ptr().add(r0 + 8)),
            _mm256_loadu_pd(b.as_ptr().add(r0 + 12)),
        ];
        let mut acc = [bb; NB];
        for &c in cols {
            let p = wp.add(c * out + r0);
            let w = [_mm256_loadu_pd(p), _mm256_loadu_pd(p.add(4)), _mm256_loadu_pd(p.add(8)), _mm256_loadu_pd(p.add(12))];
            for j in 0..NB {
                let av = _mm256_set1_pd(*a.get_unchecked(j).get_unchecked(c));
                for q in 0..4 {
                    acc[j][q] = _mm256_add_pd(acc[j][q], _mm256_mul_pd(w[q], av));
                }
            }
        }
        for j in 0..NB {
            for q in 0..4 {
                _mm256_storeu_pd(z[j].as_mut_ptr().add(r0 + 4 * q), acc[j][q]);
            }
        }
        r0 += 16;
    }
    while r0 + 8 <= out {
        let b0 = _mm256_loadu_pd(b.as_ptr().add(r0));
        let b1 = _mm256_loadu_pd(b.as_ptr().add(r0 + 4));
        let mut lo = [b0; NB];
        let mut hi = [b1; NB];
        for &c in cols {
            let p = wp.add(c * out + r0);
            let w0 = _mm256_loadu_pd(p);
            let w1 = _mm256_loadu_pd(p.add(4));
            for j in 0..NB {
                let av = _mm256_set1_pd(*a.get_unchecked(j).get_unchecked(c));
                lo[j] = _mm256_add_pd(lo[j], _mm256_mul_pd(w0, av));
                hi[j] = _mm256_add_pd(hi[j], _mm256_mul_pd(w1, av));
            }
        }
        for j in 0..NB {
            _mm256_storeu_pd(z[j].as_mut_ptr().add(r0), lo[j]);
            _mm256_storeu_pd(z[j].as_mut_ptr().add(r0 + 4), hi[j]);
        }
        r0 += 8;
    }
    for j in 0..NB {
        for r in r0..out {
            let mut s = b[r];
            for &c in cols {
                s += wt[c * out + r] * a[j][c];
            }
            z[j][r] = s;
        }
    }
}

impl Dense {
    /// z = act(W a + b) (net.ts dense()) for nb <= 4 vectors at once.
    /// Inputs that are exactly 0 (in every vector) are skipped: s + w*0 == s for any s != 0, and for
    /// s = +-0 only the sign of that zero can differ, which no later step can turn into a different
    /// non-zero value (tanh, max/min and products keep +-0 as +-0, exp(+-0) = 1).
    fn apply_batch(&self, a: &[[f64; MAXW]], z: &mut [[f64; MAXW]], nb: usize, tanh: bool) {
        let mut cols = [0usize; MAXW];
        let mut n = 0;
        for c in 0..self.inn {
            if (0..nb).any(|j| a[j][c] != 0.0) {
                cols[n] = c;
                n += 1;
            }
        }
        let cols = &cols[..n];
        macro_rules! run {
            ($nb:literal) => {{
                #[cfg(target_arch = "x86_64")]
                {
                    if std::is_x86_feature_detected!("avx2") {
                        unsafe { dense_batch_avx2::<$nb>(&self.wt, &self.b, self.out, cols, a, z) }
                    } else {
                        dense_batch_scalar::<$nb>(&self.wt, &self.b, self.out, cols, a, z)
                    }
                }
                #[cfg(not(target_arch = "x86_64"))]
                dense_batch_scalar::<$nb>(&self.wt, &self.b, self.out, cols, a, z)
            }};
        }
        match nb {
            1 => run!(1),
            2 => run!(2),
            3 => run!(3),
            4 => run!(4),
            _ => unreachable!(),
        }
        if tanh {
            #[cfg(target_arch = "x86_64")]
            let simd = std::is_x86_feature_detected!("avx2");
            #[cfg(not(target_arch = "x86_64"))]
            let simd = false;
            for j in 0..nb {
                let mut r = 0;
                #[cfg(target_arch = "x86_64")]
                if simd {
                    while r + 4 <= self.out {
                        let mut q = [z[j][r], z[j][r + 1], z[j][r + 2], z[j][r + 3]];
                        unsafe { crate::simd::tanh4(&mut q) };
                        z[j][r..r + 4].copy_from_slice(&q);
                        r += 4;
                    }
                }
                let _ = simd;
                for v in z[j][r..self.out].iter_mut() {
                    *v = jsmath::tanh(*v);
                }
            }
        }
    }

    fn from_json(v: &Value) -> Dense {
        let rows: Vec<Vec<f64>> = v["W"].as_array().unwrap().iter().map(|r| r.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect()).collect();
        let b: Vec<f64> = v["b"].as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect();
        let inn = rows[0].len();
        let out = b.len();
        assert!(inn <= MAXW && out <= MAXW, "layer wider than {MAXW}");
        let mut wt = vec![0.0; inn * out];
        for r in 0..out {
            for c in 0..inn {
                wt[c * out + r] = rows[r][c];
            }
        }
        Dense { wt, out, inn, b }
    }
}

pub struct Net {
    inputs: Vec<usize>,
    trunk: Vec<Dense>,
    pool: Dense,
    out: Dense,
    hidden: usize,
}

/// linear.ts TURN_RULES: dice in the tray by face (count / 3) and the 6s in a row (/ 2).
pub const TURN_RULES: [&str; 7] = ["tray1", "tray2", "tray3", "tray4", "tray5", "tray6", "sixes"];

pub enum Evaluator {
    /// hand-feature weights, turn-rule weights
    Linear([f64; F], [f64; 7]),
    Net(Net),
}

impl Evaluator {
    /// A weights file: linear rules ("kind": "linear") or a value net, like common.ts loadNet.
    pub fn from_json_text(text: &str) -> Evaluator {
        let v: Value = serde_json::from_str(text).unwrap();
        if v.get("kind").and_then(|k| k.as_str()) == Some("linear") {
            let get = |name: &str| v["weights"].get(name).and_then(|x| x.as_f64()).unwrap_or(0.0);
            let mut w = [0.0; F];
            for (k, name) in FEATURE_NAMES.iter().enumerate() {
                w[k] = get(name);
            }
            let mut t = [0.0; 7];
            for (k, name) in TURN_RULES.iter().enumerate() {
                t[k] = get(name);
            }
            return Evaluator::Linear(w, t);
        }
        let trunk: Vec<Dense> = v["trunk"].as_array().unwrap().iter().map(Dense::from_json).collect();
        let hidden = trunk.last().unwrap().out;
        Evaluator::Net(Net {
            inputs: v["inputs"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as usize).collect(),
            trunk,
            pool: Dense::from_json(&v["pool"]),
            out: Dense::from_json(&v["out"]),
            hidden,
        })
    }

    pub fn linear(weights: [f64; F], turn: [f64; 7]) -> Evaluator {
        Evaluator::Linear(weights, turn)
    }

    /// ownerChances(): each person's chance of winning (people = max owner + 1), into out[..people].
    pub fn owner_chances(&self, g: &Game, out: &mut [f64; 4]) -> usize {
        let ps = g.b.players();
        let people = ps.iter().map(|p| p.owner).max().unwrap() as usize + 1;
        let mut s = [0.0f64; 4];
        match self {
            Evaluator::Linear(w, turn) => {
                let mut f = [0.0f64; 4 * F];
                features(&g.b, g.current, g.singles, &mut f);
                for (i, p) in ps.iter().enumerate() {
                    for k in 0..F {
                        s[p.owner as usize] += w[k] * f[i * F + k];
                    }
                }
                let me = ps[g.current].owner as usize;
                for &r in g.tray() {
                    s[me] += turn[r as usize - 1] / 3.0;
                }
                s[me] += (turn[6] * g.sixes as f64) / 2.0;
            }
            Evaluator::Net(net) => net.owner_scores(g, people, &mut s),
        }
        let mut live = [false; 4];
        for p in ps {
            if !is_done(p) {
                live[p.owner as usize] = true;
            }
        }
        let mut top = f64::NEG_INFINITY;
        for o in 0..people {
            if live[o] {
                top = jsmath::max(top, s[o]);
            }
        }
        let mut sum = 0.0;
        for o in 0..people {
            s[o] = if live[o] { jsmath::exp(s[o] - top) } else { 0.0 };
            sum += s[o];
        }
        for o in 0..people {
            out[o] = s[o] / sum;
        }
        people
    }
}

/// Leaf values for a batch of searches: leaves[i] are valued by evals[i] (ownerChances, by owner).
/// CPU backend: every position on the thread pool; a GPU backend must give the same bits.
pub fn batch_values(evals: &[&Evaluator], leaves: &[Vec<Game>]) -> Vec<Vec<[f64; 4]>> {
    use rayon::prelude::*;
    let flat: Vec<(usize, &Game)> = leaves.iter().enumerate().flat_map(|(i, ls)| ls.iter().map(move |g| (i, g))).collect();
    let vals: Vec<[f64; 4]> = flat
        .par_iter()
        .with_min_len(64)
        .map(|&(i, g)| {
            let mut v = [0.0; 4];
            evals[i].owner_chances(g, &mut v);
            v
        })
        .collect();
    let mut it = vals.into_iter();
    leaves.iter().map(|ls| it.by_ref().take(ls.len()).collect()).collect()
}

/// Per-thread scratch for the net (no large zero-filled stack arrays per evaluation).
struct Scratch {
    x: [f64; 4 * D],
    a: [[f64; MAXW]; 4],
    z: [[f64; MAXW]; 4],
    pooled: [[f64; MAXW]; 4],
    zz: [[f64; MAXW]; 4],
    one: [[f64; MAXW]; 4],
}

thread_local! {
    static SCRATCH: std::cell::RefCell<Box<Scratch>> = std::cell::RefCell::new(Box::new(Scratch {
        x: [0.0; 4 * D],
        a: [[0.0; MAXW]; 4],
        z: [[0.0; MAXW]; 4],
        pooled: [[0.0; MAXW]; 4],
        zz: [[0.0; MAXW]; 4],
        one: [[0.0; MAXW]; 4],
    }));
}

impl Net {
    fn owner_scores(&self, g: &Game, people: usize, s: &mut [f64; 4]) {
        SCRATCH.with(|sc| self.owner_scores_in(g, people, s, &mut sc.borrow_mut()))
    }

    fn owner_scores_in(&self, g: &Game, people: usize, s: &mut [f64; 4], sc: &mut Scratch) {
        let Scratch { x, a, z, pooled, zz, one } = sc;
        encode(&g.b, g.current, g.singles, g.tray(), g.sixes, x);
        let h = self.hidden;
        let n = g.b.n;
        // every colour through the trunk together
        for i in 0..n {
            for (k, &ix) in self.inputs.iter().enumerate() {
                a[i][k] = x[i * D + ix];
            }
        }
        let (mut a, mut z) = (a, z);
        for l in &self.trunk {
            l.apply_batch(a, z, n, true);
            std::mem::swap(&mut a, &mut z);
        }
        // pool each person's colours (in colour order), then the head for every person together
        let mut who = [0usize; 4];
        let mut np = 0;
        for o in 0..people {
            let mut count = 0;
            for i in 0..n {
                if g.b.p[i].owner as usize != o {
                    continue;
                }
                let pl = &mut pooled[np];
                for k in 0..h {
                    let v = a[i][k];
                    if count == 0 {
                        pl[k] = v;
                        pl[h + k] = v;
                        pl[2 * h + k] = v;
                    } else {
                        pl[k] += v;
                        pl[h + k] = jsmath::max(pl[h + k], v);
                        pl[2 * h + k] = jsmath::min(pl[2 * h + k], v);
                    }
                }
                count += 1;
            }
            if count == 0 {
                s[o] = f64::NAN;
                continue;
            }
            who[np] = o;
            np += 1;
        }
        self.pool.apply_batch(pooled, zz, np, true);
        self.out.apply_batch(zz, one, np, false);
        for j in 0..np {
            s[who[j]] = one[j][0];
        }
    }
}
