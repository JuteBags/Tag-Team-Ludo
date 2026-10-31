//! search.ts: expectimax over whole turns (max^n for several people), with an Evaluator at the leaves.
//! The memo keys on the same fields as the TS key (current, phase, sixes, tray, tokens, turns left,
//! chance), so cache hits, and therefore every value, are the same.
use crate::bot::{score_move, Lazy};
use crate::eval::Evaluator;
use crate::game::{Game, PHASE_MOVE, PHASE_OVER};
use crate::rng::Rng;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug)]
pub struct SearchOptions {
    /// Turns looked at: 1 = my turn only, 2 = also the next player's, ...
    pub depth: u32,
    /// Chance nodes allowed within one turn before the evaluator takes over.
    pub chance: u32,
    /// Moves other people consider at each decision, best first by scoreMove (0 = all).
    pub their_k: usize,
}

impl Default for SearchOptions {
    fn default() -> Self {
        SearchOptions { depth: 1, chance: 2, their_k: 3 }
    }
}

type Key = [u8; 56];

fn key(s: &Game, turns_left: u32, chance: u32) -> Key {
    let mut k = [0u8; 56];
    k[0] = s.current as u8;
    k[1] = s.phase;
    k[2] = s.sixes;
    k[3] = s.nrolls as u8;
    k[4..4 + s.nrolls].copy_from_slice(s.tray());
    let mut o = 36;
    for p in s.b.players() {
        for &t in &p.tokens {
            k[o] = t as u8;
            o += 1;
        }
    }
    k[52] = turns_left as u8;
    k[53] = chance as u8;
    k[54] = s.b.n as u8;
    k
}

struct Ctx<'a> {
    eval: &'a Evaluator,
    opts: SearchOptions,
    owners: usize,
    root_owner: u8,
    memo: HashMap<Key, [f64; 4]>,
}

impl<'a> Ctx<'a> {
    fn owner_values(&self, s: &Game) -> [f64; 4] {
        let mut v = [0.0; 4];
        if s.phase == PHASE_OVER {
            v[s.owner_ranking()[0] as usize] = 1.0;
            return v;
        }
        self.eval.owner_chances(s, &mut v);
        v
    }

    fn node(&mut self, s: &Game, who: usize, turns_left: u32, chance: u32) -> [f64; 4] {
        if s.phase == PHASE_OVER {
            return self.owner_values(s);
        }
        if s.current != who {
            return if turns_left > 1 { self.node(s, s.current, turns_left - 1, 0) } else { self.owner_values(s) };
        }
        let k = key(s, turns_left, chance);
        if let Some(v) = self.memo.get(&k) {
            return *v;
        }
        let v: [f64; 4];
        if s.phase == PHASE_MOVE {
            let me = s.b.p[who].owner as usize;
            let n = s.moves.len();
            let mut idx: Vec<usize> = (0..n).collect();
            if me != self.root_owner as usize && self.opts.their_k > 0 && n > self.opts.their_k {
                let mut tb = Lazy::new(&s.b, s.singles);
                let sc: Vec<f64> = s.moves.as_slice().iter().map(|m| score_move(&s.b, &mut tb, s.singles, m)).collect();
                // [...moves].sort((a, b) => score(b) - score(a)): stable, best first
                idx.sort_by(|&a, &b| {
                    let d = sc[b] - sc[a];
                    if d < 0.0 {
                        std::cmp::Ordering::Less
                    } else if d > 0.0 {
                        std::cmp::Ordering::Greater
                    } else {
                        std::cmp::Ordering::Equal
                    }
                });
                idx.truncate(self.opts.their_k);
            }
            let mut best = [-1.0f64; 4];
            for &i in &idx {
                let mut t = *s;
                let m = s.moves.m[i];
                t.play(&m);
                let c = self.node(&t, who, turns_left, chance);
                if c[me] > best[me] {
                    best = c;
                }
            }
            v = best;
        } else if chance >= self.opts.chance {
            v = self.owner_values(s);
        } else {
            let mut acc = [0.0f64; 4];
            for f in 1..=6u8 {
                let mut t = *s;
                t.roll(f);
                let c = self.node(&t, who, turns_left, chance + 1);
                for o in 0..self.owners {
                    acc[o] += c[o] / 6.0;
                }
            }
            v = acc;
        }
        self.memo.insert(k, v);
        v
    }
}

/// searchValues(): the search's value of each of the current player's moves, as their chance of winning.
pub fn search_values(eval: &Evaluator, state: &Game, opts: SearchOptions) -> Vec<f64> {
    let owners = state.b.players().iter().map(|p| p.owner).max().unwrap() as usize + 1;
    let root = state.current;
    let root_owner = state.b.p[root].owner;
    let mut ctx = Ctx { eval, opts, owners, root_owner, memo: HashMap::new() };
    let me = root_owner as usize;
    state
        .moves
        .as_slice()
        .iter()
        .map(|m| {
            let mut t = *state;
            t.play(m);
            ctx.node(&t, root, opts.depth, 0)[me]
        })
        .collect()
}

/// chooseExtreme(): index of the chosen move; `temperature` > 0 samples by softmax of the values.
pub fn choose_extreme(eval: &Evaluator, state: &Game, rng: &mut Rng, opts: SearchOptions, temperature: f64) -> usize {
    if state.moves.len() == 1 {
        return 0;
    }
    let vals = search_values(eval, state, opts);
    if temperature > 0.0 {
        let mut top = f64::NEG_INFINITY;
        for &v in &vals {
            top = crate::jsmath::max(top, v);
        }
        let w: Vec<f64> = vals.iter().map(|&v| crate::jsmath::exp((v - top) / temperature)).collect();
        let mut total = 0.0;
        for &x in &w {
            total += x;
        }
        let mut r = rng.next() * total;
        for (i, &x) in w.iter().enumerate() {
            r -= x;
            if r <= 0.0 {
                return i;
            }
        }
    }
    let mut best = 0usize;
    for (i, &v) in vals.iter().enumerate() {
        if v + rng.next() * 1e-9 > vals[best] {
            best = i;
        }
    }
    best
}
