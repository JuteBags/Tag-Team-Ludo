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
    /// Value v1 race positions exactly with the race database (race.rs).
    pub race: bool,
}

impl Default for SearchOptions {
    fn default() -> Self {
        SearchOptions { depth: 1, chance: 2, their_k: 3, race: false }
    }
}

type Key = [u8; 64];

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

type Map<V> = HashMap<Key, V, std::hash::BuildHasherDefault<KeyHasher>>;

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
        self.eval.owner_chances(s, &mut v);
        self.leaves.insert(k, v);
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

/// Every person's value of a position, by the search from there: the current player plans the rest of
/// their turn (depth turns, fair 1/6 chance nodes). For measurement (AIVAT) and labels.
pub fn state_values(eval: &Evaluator, state: &Game, opts: SearchOptions) -> [f64; 4] {
    let owners = state.b.players().iter().map(|p| p.owner).max().unwrap() as usize + 1;
    let root_owner = state.b.p[state.current].owner;
    let mut ctx = Ctx { eval, opts, owners, root_owner, memo: Map::default(), leaves: Map::default() };
    ctx.node(state, state.current, opts.depth, 0)
}

/// searchValues(): the search's value of each of the current player's moves, as their chance of winning.
pub fn search_values(eval: &Evaluator, state: &Game, opts: SearchOptions) -> Vec<f64> {
    let owners = state.b.players().iter().map(|p| p.owner).max().unwrap() as usize + 1;
    let root = state.current;
    let root_owner = state.b.p[root].owner;
    let mut ctx = Ctx { eval, opts, owners, root_owner, memo: Map::default(), leaves: Map::default() };
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

/// search.ts searchStats: how often temperature sampling picked a move whose value is below the best.
pub static SAMPLED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static OFF_BEST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

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
