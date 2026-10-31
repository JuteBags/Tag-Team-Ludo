//! Position evaluators: linear.ts (readable rules) and net.ts (the value net). Each gives every person
//! their chance of winning; f64 throughout, sums in the TypeScript order, V8's exp/tanh (jsmath).
use crate::encode::{encode, features, D, F, FEATURE_NAMES};
use crate::game::Game;
use crate::jsmath;
use crate::rules::is_done;
use serde_json::Value;

struct Dense {
    w: Vec<f64>,
    b: Vec<f64>,
    out: usize,
    inn: usize,
}

impl Dense {
    fn from_json(v: &Value) -> Dense {
        let rows: Vec<Vec<f64>> = v["W"].as_array().unwrap().iter().map(|r| r.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect()).collect();
        let b: Vec<f64> = v["b"].as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect();
        let inn = rows[0].len();
        Dense { w: rows.concat(), out: b.len(), inn, b }
    }

    /// z = act(W a + b), net.ts dense().
    #[inline]
    fn apply(&self, a: &[f64], z: &mut [f64], tanh: bool) {
        for r in 0..self.out {
            let mut s = self.b[r];
            let row = &self.w[r * self.inn..(r + 1) * self.inn];
            for c in 0..self.inn {
                s += row[c] * a[c];
            }
            z[r] = if tanh { jsmath::tanh(s) } else { s };
        }
    }
}

pub struct Net {
    inputs: Vec<usize>,
    trunk: Vec<Dense>,
    pool: Dense,
    out: Dense,
    hidden: usize,
}

pub enum Evaluator {
    Linear([f64; F]),
    Net(Net),
}

impl Evaluator {
    /// A weights file: linear rules ("kind": "linear") or a value net, like common.ts loadNet.
    pub fn from_json_text(text: &str) -> Evaluator {
        let v: Value = serde_json::from_str(text).unwrap();
        if v.get("kind").and_then(|k| k.as_str()) == Some("linear") {
            let mut w = [0.0; F];
            for (k, name) in FEATURE_NAMES.iter().enumerate() {
                w[k] = v["weights"].get(*name).and_then(|x| x.as_f64()).unwrap_or(0.0);
            }
            return Evaluator::Linear(w);
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

    pub fn linear(weights: [f64; F]) -> Evaluator {
        Evaluator::Linear(weights)
    }

    /// ownerChances(): each person's chance of winning (people = max owner + 1), into out[..people].
    pub fn owner_chances(&self, g: &Game, out: &mut [f64; 4]) -> usize {
        let ps = g.b.players();
        let people = ps.iter().map(|p| p.owner).max().unwrap() as usize + 1;
        let mut s = [0.0f64; 4];
        match self {
            Evaluator::Linear(w) => {
                let mut f = [0.0f64; 4 * F];
                features(&g.b, g.current, g.singles, &mut f);
                for (i, p) in ps.iter().enumerate() {
                    for k in 0..F {
                        s[p.owner as usize] += w[k] * f[i * F + k];
                    }
                }
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

impl Net {
    fn owner_scores(&self, g: &Game, people: usize, s: &mut [f64; 4]) {
        let mut x = [0.0f64; 4 * D];
        encode(&g.b, g.current, g.singles, g.tray(), g.sixes, &mut x);
        let h = self.hidden;
        let n = g.b.n;
        let widest = self.trunk.iter().map(|l| l.out).max().unwrap().max(self.inputs.len());
        let mut a = vec![0.0f64; widest];
        let mut z = vec![0.0f64; widest];
        let mut hs = vec![0.0f64; 4 * h];
        for i in 0..n {
            for (k, &ix) in self.inputs.iter().enumerate() {
                a[k] = x[i * D + ix];
            }
            for l in &self.trunk {
                l.apply(&a, &mut z, true);
                std::mem::swap(&mut a, &mut z);
            }
            hs[i * h..(i + 1) * h].copy_from_slice(&a[..h]);
        }
        let mut pooled = vec![0.0f64; 3 * h];
        let mut zz = vec![0.0f64; self.pool.out];
        let mut one = [0.0f64; 1];
        for o in 0..people {
            let mut count = 0;
            for i in 0..n {
                if g.b.p[i].owner as usize != o {
                    continue;
                }
                for k in 0..h {
                    let v = hs[i * h + k];
                    if count == 0 {
                        pooled[k] = v;
                        pooled[h + k] = v;
                        pooled[2 * h + k] = v;
                    } else {
                        pooled[k] += v;
                        pooled[h + k] = jsmath::max(pooled[h + k], v);
                        pooled[2 * h + k] = jsmath::min(pooled[2 * h + k], v);
                    }
                }
                count += 1;
            }
            if count == 0 {
                s[o] = f64::NAN;
                continue;
            }
            self.pool.apply(&pooled, &mut zz, true);
            self.out.apply(&zz, &mut one, false);
            s[o] = one[0];
        }
    }
}
