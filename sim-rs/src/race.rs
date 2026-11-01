//! Exact race database, v1: positions where every token still in play (of every colour) is in its home
//! column. Nobody can capture or block anyone any more, so each colour's future is its own: a small
//! dynamic programme over its tokens' distances to the centre (1..5) and the turn rules (the tray, a 6
//! rolls again and is useless here, three 6s cancel, a token reaching the centre rolls again, unusable
//! dice are lost). Fair dice (1/6 per face): this is the engine's model, for play only, never for labels.
//!
//! Per colour: the play that minimises the expected number of turns to finish, and under it the exact
//! distribution of how many own turns it takes. Colours then finish independently; a colour's k-th turn
//! comes in round k at its seat, so finishing events order by (turns, seat from the current colour), and
//! each person's chance of being first follows exactly. The same arithmetic, in the same order, is in
//! src/engine/ai/race.ts, so both give the same bits.
use crate::game::{Game, PHASE_ROLL};
use crate::rules::{is_done, FINISHED, HOME_FIRST};
use std::collections::HashMap;
use std::sync::OnceLock;

/// Turns tracked per distribution (the mass beyond is below 1e-20).
pub const NMAX: usize = 256;

/// A colour's state: how many tokens sit at distance 1..5 from the centre.
type Counts = [u8; 5];

fn key(c: &Counts) -> usize {
    c[0] as usize + 5 * c[1] as usize + 25 * c[2] as usize + 125 * c[3] as usize + 625 * c[4] as usize
}

fn pips(c: &Counts) -> u32 {
    (0..5).map(|i| c[i] as u32 * (i as u32 + 1)).sum()
}

/// All states with at most 4 tokens, in the order the DP needs them: fewer pips first, then by key.
fn all_states() -> Vec<Counts> {
    let mut v = Vec::new();
    for a in 0..=4u8 {
        for b in 0..=4 - a {
            for c in 0..=4 - a - b {
                for d in 0..=4 - a - b - c {
                    for e in 0..=4 - a - b - c - d {
                        v.push([a, b, c, d, e]);
                    }
                }
            }
        }
    }
    v.sort_by_key(|s| (pips(s), key(s)));
    v
}

pub struct RaceDb {
    /// compact index of each state key (usize::MAX if not a state)
    idx: Vec<usize>,
    states: Vec<Counts>,
    /// expected own turns to finish from a turn start
    exp: Vec<f64>,
    /// dist[s][n]: probability of finishing on own turn n (n >= 1) from a turn start
    dist: Vec<Vec<f64>>,
}

/// One roll run: the face that ends it (1..5, after any number of useless 6s) or three 6s in a row.
/// With `s` 6s already rolled in this run.
fn run_probs(s: u8) -> ([f64; 5], f64) {
    let (p, cancel) = match s {
        0 => (43.0 / 216.0, 1.0 / 216.0),
        1 => (7.0 / 36.0, 1.0 / 36.0),
        _ => (1.0 / 6.0, 1.0 / 6.0),
    };
    ([p; 5], cancel)
}

/// Within-turn DP for one colour, memoised per (state, tray, mode).
struct Turn<'a> {
    db: &'a RaceDb,
    /// value of a turn-end state (expected future turns); only states with fewer pips than the turn start
    end_value: &'a dyn Fn(usize) -> f64,
    memo: HashMap<(usize, [u8; 5], u8), (f64, Vec<f64>)>,
}

impl<'a> Turn<'a> {
    fn n(&self) -> usize {
        self.db.states.len()
    }

    /// Ends the turn in `c`: (its value, a distribution concentrated on it).
    fn end(&self, c: &Counts) -> (f64, Vec<f64>) {
        let i = self.db.idx[key(c)];
        let mut d = vec![0.0; self.n()];
        d[i] = 1.0;
        ((self.end_value)(i), d)
    }

    /// A roll run, then play (`s` 6s already in this run).
    fn run(&mut self, c: Counts, tray: [u8; 5], s: u8) -> (f64, Vec<f64>) {
        let k = (key(&c), tray, 10 + s);
        if let Some(v) = self.memo.get(&k) {
            return v.clone();
        }
        let (p, cancel) = run_probs(s);
        let mut val = 0.0;
        let mut dist = vec![0.0; self.n()];
        for r in 1..=5usize {
            let mut t = tray;
            t[r - 1] += 1;
            let (v, d) = self.play(c, t);
            val += p[r - 1] * v;
            for j in 0..dist.len() {
                dist[j] += p[r - 1] * d[j];
            }
        }
        // three 6s: the dice kept from before the run are played
        let (v, d) = self.play(c, tray);
        val += cancel * v;
        for j in 0..dist.len() {
            dist[j] += cancel * d[j];
        }
        self.memo.insert(k, (val, dist.clone()));
        (val, dist)
    }

    /// Play the tray: the move with the lowest expected future turns (first such in die-high-first,
    /// distance-low-first order), or end the turn when nothing can move.
    fn play(&mut self, c: Counts, tray: [u8; 5]) -> (f64, Vec<f64>) {
        let k = (key(&c), tray, 0);
        if let Some(v) = self.memo.get(&k) {
            return v.clone();
        }
        let mut best: Option<(f64, Vec<f64>)> = None;
        for r in (1..=5usize).rev() {
            if tray[r - 1] == 0 {
                continue;
            }
            for d in r..=5usize {
                if c[d - 1] == 0 {
                    continue;
                }
                let mut c2 = c;
                c2[d - 1] -= 1;
                let finished = d == r;
                if !finished {
                    c2[d - r - 1] += 1;
                }
                let mut t2 = tray;
                t2[r - 1] -= 1;
                let done = c2.iter().all(|&x| x == 0);
                let out = if done {
                    self.end(&c2)
                } else if finished {
                    self.run(c2, t2, 0)
                } else {
                    self.play(c2, t2)
                };
                if best.as_ref().is_none_or(|b| out.0 < b.0) {
                    best = Some(out);
                }
            }
        }
        let res = best.unwrap_or_else(|| self.end(&c));
        self.memo.insert(k, res.clone());
        res
    }
}

impl RaceDb {
    fn build() -> RaceDb {
        let states = all_states();
        let mut idx = vec![usize::MAX; 3125];
        for (i, s) in states.iter().enumerate() {
            idx[key(s)] = i;
        }
        let n = states.len();
        let mut db = RaceDb { idx, states, exp: vec![0.0; n], dist: vec![vec![0.0; NMAX]; n] };
        db.dist[0][0] = 1.0; // states[0] is the empty colour: done
        for i in 1..n {
            let c = db.states[i];
            // first roll run from the turn start: outcomes that cannot move at all end the turn in c
            let exp_snapshot = db.exp.clone();
            let end_value = move |j: usize| exp_snapshot[j];
            let mut t = Turn { db: &db, end_value: &end_value, memo: HashMap::new() };
            let (p, cancel) = run_probs(0);
            let mut p_self = 0.0;
            let mut fut = 0.0;
            let mut q = vec![0.0; n];
            for r in 1..=5usize {
                let can_move = (r..=5).any(|d| c[d - 1] > 0);
                if !can_move {
                    p_self += p[r - 1];
                    continue;
                }
                let mut tray = [0u8; 5];
                tray[r - 1] = 1;
                let (v, d) = t.play(c, tray);
                fut += p[r - 1] * v;
                for j in 0..n {
                    q[j] += p[r - 1] * d[j];
                }
            }
            p_self += cancel;
            db.exp[i] = (1.0 + fut) / (1.0 - p_self);
            let mut dist = vec![0.0; NMAX];
            for m in 1..NMAX {
                let mut s = p_self * dist[m - 1];
                for j in 0..i {
                    s += q[j] * db.dist[j][m - 1];
                }
                dist[m] = s;
            }
            db.dist[i] = dist;
        }
        db
    }

    pub fn get() -> &'static RaceDb {
        static DB: OnceLock<RaceDb> = OnceLock::new();
        DB.get_or_init(RaceDb::build)
    }

    pub fn expected_turns(&self, c: &Counts) -> f64 {
        self.exp[self.idx[key(c)]]
    }

    /// Distribution of own turns to finish for the colour about to act, mid-turn: the rest of this turn
    /// (tray, 6s in the current run, a roll pending) counts as turn 1.
    fn current_dist(&self, c: Counts, tray: [u8; 5], sixes: u8) -> Vec<f64> {
        let n = self.states.len();
        let end_value = |j: usize| self.exp[j];
        let mut t = Turn { db: self, end_value: &end_value, memo: HashMap::new() };
        let (_, q) = t.run(c, tray, sixes);
        let mut dist = vec![0.0; NMAX];
        for m in 1..NMAX {
            let mut s = 0.0;
            for j in 0..n {
                s += q[j] * self.dist[j][m - 1];
            }
            dist[m] = s;
        }
        dist
    }
}

/// The database's move in a v1 race position (phase 'move'): the legal move with the lowest expected
/// future turns for the colour to move (first such in the engine's move order).
pub fn race_move(g: &Game) -> usize {
    let db = RaceDb::get();
    let c = home_counts(&g.b.p[g.current].tokens).expect("a race position");
    let mut tray = [0u8; 5];
    for &r in g.tray() {
        if r <= 5 {
            tray[r as usize - 1] += 1;
        }
    }
    let end_value = |j: usize| db.exp[j];
    let mut t = Turn { db, end_value: &end_value, memo: HashMap::new() };
    let mut best = (f64::INFINITY, 0usize);
    for (k, m) in g.moves.as_slice().iter().enumerate() {
        let r = m.roll as usize;
        let d = (FINISHED - m.from) as usize;
        let mut c2 = c;
        c2[d - 1] -= 1;
        let finished = d == r;
        if !finished {
            c2[d - r - 1] += 1;
        }
        let mut t2 = tray;
        t2[r - 1] -= 1;
        let v = if c2.iter().all(|&x| x == 0) {
            0.0
        } else if finished {
            t.run(c2, t2, 0).0
        } else {
            t.play(c2, t2).0
        };
        if v < best.0 {
            best = (v, k);
        }
    }
    best.1
}

/// A colour's distances to the centre, if all its tokens are in the home column or finished.
fn home_counts(tokens: &[i8; 4]) -> Option<Counts> {
    let mut c = [0u8; 5];
    for &t in tokens {
        if t == FINISHED {
            continue;
        }
        if t < HOME_FIRST {
            return None;
        }
        c[(FINISHED - t) as usize - 1] += 1;
    }
    Some(c)
}

/// Each person's chance of finishing first (among people still playing) if `g` is a v1 race position
/// before a roll; None otherwise.
pub fn race_chances(g: &Game) -> Option<[f64; 4]> {
    if g.phase != PHASE_ROLL {
        return None;
    }
    let ps = g.b.players();
    let n = ps.len();
    let mut counts = [[0u8; 5]; 4];
    for (i, p) in ps.iter().enumerate() {
        counts[i] = home_counts(&p.tokens)?;
    }
    let db = RaceDb::get();
    // per colour: distribution of own turns to finish (None when already done)
    let mut tray = [0u8; 5];
    for &r in g.tray() {
        if r <= 5 {
            tray[r as usize - 1] += 1;
        }
    }
    let mut dists: Vec<Option<Vec<f64>>> = Vec::with_capacity(n);
    for i in 0..n {
        if is_done(&ps[i]) {
            dists.push(None);
        } else if i == g.current {
            dists.push(Some(db.current_dist(counts[i], tray, g.sixes)));
        } else {
            dists.push(Some(db.dist[db.idx[key(&counts[i])]].clone()));
        }
    }
    let people = ps.iter().map(|p| p.owner).max().unwrap() as usize + 1;
    // G_i(t, o): P(colour i's finishing event (turns, seat) <= (t, o)); seat = order from the current colour
    let seat = |i: usize| (i + n - g.current) % n;
    // F_p(k) over keys k = (t, o) in order: product of its live colours' G
    let nk = NMAX * n;
    let mut f = vec![vec![1.0f64; nk]; people];
    let mut live = [false; 4];
    for i in 0..n {
        let Some(d) = &dists[i] else { continue };
        let o = ps[i].owner as usize;
        live[o] = true;
        let mut below = 0.0; // P(T < t)
        for t in 0..NMAX {
            for s in 0..n {
                let g_ = if seat(i) <= s { below + d[t] } else { below };
                f[o][t * n + s] *= g_;
            }
            below += d[t];
        }
    }
    let mut out = [0.0f64; 4];
    let mut total = 0.0;
    for p in 0..people {
        if !live[p] {
            continue;
        }
        let mut acc = 0.0;
        let mut prev = 0.0;
        for k in 0..nk {
            let pk = f[p][k] - prev;
            prev = f[p][k];
            if pk == 0.0 {
                continue;
            }
            let mut others = 1.0;
            for q in 0..people {
                if q != p && live[q] {
                    others *= 1.0 - f[q][k];
                }
            }
            acc += pk * others;
        }
        out[p] = acc;
        total += acc;
    }
    for p in 0..people {
        out[p] /= total;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distributions_sum_to_one_and_match_expectation() {
        let db = RaceDb::get();
        for (i, _) in db.states.iter().enumerate().skip(1) {
            let s: f64 = db.dist[i].iter().sum();
            let m: f64 = db.dist[i].iter().enumerate().map(|(n, p)| n as f64 * p).sum();
            assert!((s - 1.0).abs() < 1e-12, "state {i}: mass {s}");
            assert!((m - db.exp[i]).abs() < 1e-9, "state {i}: mean {m} vs {}", db.exp[i]);
        }
    }
}
