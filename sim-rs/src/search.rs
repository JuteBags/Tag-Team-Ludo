//! search.ts: expectimax over whole turns (max^n for several people), with an Evaluator at the leaves.
//! The memo keys on the same fields as the TS key (current, phase, sixes, tray, tokens, turns left,
//! chance), so cache hits, and therefore every value, are the same.
use crate::bot::{score_move, Lazy};
use crate::eval::Evaluator;
use crate::game::{Game, PHASE_MOVE, PHASE_OVER, PHASE_ROLL};
use std::sync::atomic::Ordering::Relaxed;
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
    /// Value v1 race positions exactly with the race database (race.rs).
    pub race: bool,
    /// search.ts SearchOptions.cut: ChanceProbCut-style probe cut (0 = off, exact).
    pub cut: f64,
}

impl Default for SearchOptions {
    fn default() -> Self {
        SearchOptions { depth: 1, chance: 2, their_k: 3, race: false, cut: 0.0 }
    }
}

pub type Key = [u8; 64];

/// FxHash-style hasher for the fixed 64-byte keys (SipHash is far slower and needs no DoS resistance here).
#[derive(Default)]
pub struct KeyHasher(u64);

impl std::hash::Hasher for KeyHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for c in bytes.chunks(8) {
            let mut w = [0u8; 8];
            w[..c.len()].copy_from_slice(c);
            self.0 = (self.0.rotate_left(5) ^ u64::from_le_bytes(w)).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
        }
    }
}

pub type Map<V> = HashMap<Key, V, std::hash::BuildHasherDefault<KeyHasher>>;

/// The leaf cache key of a position (the evaluator's value depends on the position alone).
pub fn leaf_key(s: &Game) -> Key {
    key(s, 0, 255)
}

fn key(s: &Game, turns_left: u32, chance: u32) -> Key {
    let mut k = [0u8; 64];
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
    // the finishing order (search.ts key: ...|ranking|tokens)
    k[55] = s.nrank as u8;
    for (i, &c) in s.ranking[..s.nrank].iter().enumerate() {
        k[56 + i] = c + 1;
    }
    k
}

struct Ctx<'a> {
    eval: &'a Evaluator,
    opts: SearchOptions,
    owners: usize,
    root_owner: u8,
    memo: Map<[f64; 4]>,
    /// Leaf values by position alone: the evaluator (and the race database) depend only on the position,
    /// so a position reached again (other dice order, other chance depth) reuses the value exactly.
    leaves: Map<[f64; 4]>,
    /// Collecting (collect_leaves): positions the evaluator would be asked for are listed (once each)
    /// and valued 0 instead. With cut 0 the search visits the same nodes whatever the values are.
    collect: Option<Vec<Game>>,
}

impl<'a> Ctx<'a> {
    fn owner_values(&mut self, s: &Game) -> [f64; 4] {
        let mut v = [0.0; 4];
        if s.phase == PHASE_OVER {
            v[s.owner_ranking()[0] as usize] = 1.0;
            return v;
        }
        let k = key(s, 0, 255);
        if let Some(v) = self.leaves.get(&k) {
            return *v;
        }
        if self.opts.race {
            if let Some(r) = crate::race::race_chances(s) {
                self.leaves.insert(k, r);
                return r;
            }
        }
        if let Some(c) = self.collect.as_mut() {
            c.push(*s);
            self.leaves.insert(k, v);
            return v;
        }
        self.eval.owner_chances(s, &mut v);
        self.leaves.insert(k, v);
        v
    }

    /// search.ts children(): each listed move's child value, in `idx` order (SearchOptions.cut).
    fn children(&mut self, s: &Game, idx: &[usize], who: usize, turns_left: u32, chance: u32, me: usize) -> Vec<[f64; 4]> {
        let ts: Vec<Game> = idx
            .iter()
            .map(|&i| {
                let mut t = *s;
                t.play(&s.moves.m[i]);
                t
            })
            .collect();
        if self.opts.cut <= 0.0 {
            return ts.iter().map(|t| self.node(t, who, turns_left, chance)).collect();
        }
        let max_chance = self.opts.chance;
        let deep = |t: &Game| t.phase == PHASE_ROLL && if t.current == who { chance < max_chance } else { turns_left > 1 };
        let mut vals = vec![[0.0f64; 4]; ts.len()];
        let mut probes: Vec<(usize, [f64; 4])> = Vec::new();
        let mut a = -1.0f64;
        for (i, t) in ts.iter().enumerate() {
            if deep(t) {
                probes.push((i, self.owner_values(t)));
                if self.collect.is_none() {
                    PROBES.fetch_add(1, Relaxed);
                }
            } else {
                vals[i] = self.node(t, who, turns_left, chance);
                if vals[i][me] > a {
                    a = vals[i][me];
                }
            }
        }
        // probes.sort((x, y) => y[me] - x[me]): stable, best probe first
        probes.sort_by(|x, y| {
            let d = y.1[me] - x.1[me];
            if d < 0.0 {
                std::cmp::Ordering::Less
            } else if d > 0.0 {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        });
        for (i, p) in probes {
            if p[me] + self.opts.cut <= a {
                vals[i] = p;
                if self.collect.is_none() {
                    CUTS.fetch_add(1, Relaxed);
                }
            } else {
                vals[i] = self.node(&ts[i], who, turns_left, chance);
                if vals[i][me] > a {
                    a = vals[i][me];
                }
            }
        }
        vals
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
            for c in self.children(s, &idx, who, turns_left, chance, me) {
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

/// Every person's value of a position, by the search from there: the current player plans the rest of
/// their turn (depth turns, fair 1/6 chance nodes). For measurement (AIVAT) and labels.
pub fn state_values(eval: &Evaluator, state: &Game, opts: SearchOptions) -> [f64; 4] {
    let owners = state.b.players().iter().map(|p| p.owner).max().unwrap() as usize + 1;
    let root_owner = state.b.p[state.current].owner;
    let mut ctx = Ctx { eval, opts, owners, root_owner, memo: Map::default(), leaves: Map::default(), collect: None };
    ctx.node(state, state.current, opts.depth, 0)
}

fn root_values(eval: &Evaluator, state: &Game, opts: SearchOptions, leaves: Map<[f64; 4]>, collect: Option<Vec<Game>>) -> (Vec<f64>, Option<Vec<Game>>) {
    let owners = state.b.players().iter().map(|p| p.owner).max().unwrap() as usize + 1;
    let root = state.current;
    let root_owner = state.b.p[root].owner;
    let mut ctx = Ctx { eval, opts, owners, root_owner, memo: Map::default(), leaves, collect };
    let me = root_owner as usize;
    let idx: Vec<usize> = (0..state.moves.len()).collect();
    let vals = ctx.children(state, &idx, root, opts.depth, 0, me).iter().map(|v| v[me]).collect();
    (vals, ctx.collect)
}

/// searchValues(): the search's value of each of the current player's moves, as their chance of winning.
pub fn search_values(eval: &Evaluator, state: &Game, opts: SearchOptions) -> Vec<f64> {
    root_values(eval, state, opts, Map::default(), None).0
}

/// Batched search, pass 1: every distinct position search_values would hand the evaluator (the race
/// database and finished games aside). Value them together (eval_batch, or a GPU), put them in a map by
/// leaf_key, and search_values_with gives exactly search_values. With cut > 0 the walk depends on the
/// values, so the list can miss some; search_values_with then evaluates those itself (still exact).
pub fn collect_leaves(eval: &Evaluator, state: &Game, opts: SearchOptions) -> Vec<Game> {
    root_values(eval, state, opts, Map::default(), Some(Vec::new())).1.unwrap()
}

/// search_values with leaf values already known (pass 2 of the batched search).
pub fn search_values_with(eval: &Evaluator, state: &Game, opts: SearchOptions, leaves: Map<[f64; 4]>) -> Vec<f64> {
    root_values(eval, state, opts, leaves, None).0
}

/// search.ts searchStats: how often temperature sampling picked a move whose value is below the best.
pub static SAMPLED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static OFF_BEST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// search.ts searchStats.probes / cuts: children the cut valued by the evaluator alone, and kept so.
pub static PROBES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static CUTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// chooseExtreme(): index of the chosen move; `temperature` > 0 samples by softmax of the values.
pub fn choose_extreme(eval: &Evaluator, state: &Game, rng: &mut Rng, opts: SearchOptions, temperature: f64) -> usize {
    if state.moves.len() == 1 {
        return 0;
    }
    pick(search_values(eval, state, opts), rng, temperature)
}

/// choose_extreme with leaf values already known (the batched search).
pub fn choose_extreme_with(eval: &Evaluator, state: &Game, rng: &mut Rng, opts: SearchOptions, temperature: f64, leaves: Map<[f64; 4]>) -> usize {
    if state.moves.len() == 1 {
        return 0;
    }
    pick(search_values_with(eval, state, opts, leaves), rng, temperature)
}

/// chooseExtreme's choice from the move values: softmax sampling, or the best with tiny random ties.
fn pick(vals: Vec<f64>, rng: &mut Rng, temperature: f64) -> usize {
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
                SAMPLED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if vals[i] < top {
                    OFF_BEST.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
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
