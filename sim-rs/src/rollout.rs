//! Monte Carlo rollout player, a policy-improvement operator over `base`: at each decision every distinct
//! legal move is played out `n` times with every seat (its own included) played by `base` afterwards, on
//! FAIR dice, and the player leaves base's own move only for a move whose PAIRED mean advantage over it is
//! significant (more than `Z` standard errors), so it is never worse than base on noise.
//! Pairing: playout i of every candidate uses the same streams, and the dice are drawn per seat (each
//! colour has its own stream), so a different move of mine does not shift the other players' dice; the
//! candidates' playouts stay aligned and their differences carry little dice noise.
//! With `cut` > 0 a playout stops after `cut` turn changes and is scored by `eval`'s chance for the mover's
//! person (at the next position before a roll); with `cut` = 0 it runs to the end (1 if the person finishes
//! first, else 0). A measurement / ceiling and expert-data tool, not an app player.
use crate::bot::Policy;
use crate::dice::{sample_face, FAIR};
use crate::eval::Evaluator;
use crate::game::{Game, PHASE_OVER, PHASE_ROLL};
use crate::rng::Rng;
use crate::search::leaf_key;

/// Significance for leaving base's move (paired mean advantage / its standard error).
const Z: f64 = 2.0;

fn playout(mut g: Game, base: &Policy, mine: &Policy, me: u8, dice: &mut [Rng; 4], rng: &mut Rng, cut: u32, eval: Option<&Evaluator>) -> f64 {
    let mut turns = 0u32;
    let mut cur = g.current;
    let mut steps = 0;
    while g.phase != PHASE_OVER && steps < 50000 {
        if g.phase == PHASE_ROLL {
            if cut > 0 && turns >= cut {
                if let Some(e) = eval {
                    let mut v = [0.0f64; 4];
                    e.owner_chances(&g, &mut v);
                    return v[me as usize];
                }
            }
            let f = sample_face(&FAIR, &mut dice[g.current]);
            g.roll(f);
        } else {
            let k = if g.b.p[g.current].owner == me { mine.choose(&g, rng) } else { base.choose(&g, rng) };
            let m = g.moves.m[k];
            g.play(&m);
        }
        if g.current != cur {
            cur = g.current;
            turns += 1;
        }
        steps += 1;
    }
    if g.phase == PHASE_OVER && g.owner_ranking()[0] == me {
        1.0
    } else {
        0.0
    }
}

/// One decision's candidates: (move index, resulting position, mean playout result for the mover), the
/// candidate holding base's own move, and the rollout player's pick (both indexes into the list).
pub struct Evaluation {
    pub cands: Vec<(usize, Game, f64)>,
    pub base: usize,
    pub pick: usize,
}

/// The rollout player's choice (an index into g.moves). Draws one number from `rng` per decision.
pub fn choose(g: &Game, rng: &mut Rng, n: usize, cut: u32, eval: Option<&Evaluator>, base: &Policy) -> usize {
    if g.moves.len() == 1 {
        return 0;
    }
    let e = evaluate(g, rng, n, cut, eval, base);
    e.cands[e.pick].0
}

/// Every distinct candidate's paired playout mean (see the module doc); `g` must have several moves.
pub fn evaluate(g: &Game, rng: &mut Rng, n: usize, cut: u32, eval: Option<&Evaluator>, base: &Policy) -> Evaluation {
    let nm = g.moves.len();
    assert!(nm > 1, "rollout::evaluate needs several moves");
    let me = g.b.p[g.current].owner;
    let seed = (rng.next() * 2_147_483_647.0) as i64;
    // base's own move, and the distinct resulting positions (two moves can lead to the same position)
    let kb = base.choose(g, &mut Rng::seeded(seed ^ 0x0bad_5eed));
    let mut cands: Vec<(usize, Game)> = Vec::new();
    let mut keys = Vec::new();
    for k in 0..nm {
        let mut t = *g;
        t.play(&g.moves.m[k]);
        let key = leaf_key(&t);
        if !keys.contains(&key) {
            keys.push(key);
            cands.push((k, t));
        }
    }
    let mut tb = *g;
    tb.play(&g.moves.m[kb]);
    let bkey = leaf_key(&tb);
    let b = keys.iter().position(|k| *k == bkey).unwrap();
    if cands.len() == 1 {
        return Evaluation { cands: vec![(cands[0].0, cands[0].1, f64::NAN)], base: 0, pick: 0 };
    }
    // paired outcomes: res[c][i]
    let mut res = vec![vec![0.0f64; n]; cands.len()];
    for i in 0..n {
        let s = seed.wrapping_mul(7919).wrapping_add(i as i64);
        for (c, (_, t)) in cands.iter().enumerate() {
            let mut d = [Rng::seeded(s), Rng::seeded(s ^ 0x1111), Rng::seeded(s ^ 0x2222), Rng::seeded(s ^ 0x3333)];
            let mut r = Rng::seeded(s ^ 0x1234_5678);
            res[c][i] = playout(*t, base, base, me, &mut d, &mut r, cut, eval);
        }
    }
    // leave base's move only for the best candidate whose paired advantage is significant
    let mut best = b;
    let mut best_adv = 0.0;
    let mut stats = Vec::new();
    for c in 0..cands.len() {
        if c == b {
            continue;
        }
        let diffs: Vec<f64> = (0..n).map(|i| res[c][i] - res[b][i]).collect();
        let mean = diffs.iter().sum::<f64>() / n as f64;
        let var = diffs.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>() / (n.max(2) - 1) as f64;
        let se = (var / n as f64).sqrt();
        stats.push((c, mean, se));
        if mean > Z * se && mean > best_adv {
            best = c;
            best_adv = mean;
        }
    }
    if std::env::var_os("LUDO_ROLLOUT_DEBUG").is_some() {
        eprintln!("ROLLOUT me {me} moves {nm} cands {} base {b} pick {best} paired (cand, mean, se) {:?}", cands.len(), stats);
    }
    let means: Vec<f64> = res.iter().map(|r| r.iter().sum::<f64>() / n as f64).collect();
    Evaluation { cands: cands.into_iter().zip(means).map(|((k, t), m)| (k, t, m)).collect(), base: b, pick: best }
}

/// One playout to run: the candidate's position, the playout's seed (its dice streams and policy rng
/// derive from it as in evaluate) and the mover's person.
#[derive(Clone, Copy)]
pub struct Job {
    pub start: Game,
    pub seed: i64,
    pub me: u8,
}

/// Runs a round of playouts. The CPU runs them one by one; a GPU backend runs whole batches from many
/// threads at once and must return bit-identical results (the parity gate).
pub trait Playouts: Send + Sync {
    fn run(&self, jobs: &[Job], cut: u32, eval: Option<&Evaluator>, base: &Policy, mine: &Policy) -> Vec<f64>;
}

/// The reference backend: rollout.rs playout() per job.
pub struct Cpu;

impl Playouts for Cpu {
    fn run(&self, jobs: &[Job], cut: u32, eval: Option<&Evaluator>, base: &Policy, mine: &Policy) -> Vec<f64> {
        jobs.iter().map(|j| cpu_playout(j, cut, eval, base, mine)).collect()
    }
}

/// One job on the CPU: the dice per seat and the policy rng from its seed.
pub fn cpu_playout(j: &Job, cut: u32, eval: Option<&Evaluator>, base: &Policy, mine: &Policy) -> f64 {
    let s = j.seed;
    let mut d = [Rng::seeded(s), Rng::seeded(s ^ 0x1111), Rng::seeded(s ^ 0x2222), Rng::seeded(s ^ 0x3333)];
    let mut r = Rng::seeded(s ^ 0x1234_5678);
    playout(j.start, base, mine, j.me, &mut d, &mut r, cut, eval)
}

static BACKEND: std::sync::OnceLock<Box<dyn Playouts>> = std::sync::OnceLock::new();

/// Installs the race's playout backend (once, before the first decision); the CPU when never set.
pub fn set_backend(b: Box<dyn Playouts>) {
    assert!(BACKEND.set(b).is_ok(), "playout backend set twice");
}

fn backend() -> &'static dyn Playouts {
    BACKEND.get_or_init(|| Box::new(Cpu)).as_ref()
}

/// Playouts per round of the race; a candidate can drop out after each round.
const BATCH: usize = 16;
/// A candidate stops once its paired deficit to the leader is this many standard errors.
const Z_DROP: f64 = 3.0;
/// The race stops when every remaining candidate is within this of the leader (with 2 se): a near tie
/// is worth less than the playouts it would take to break it.
const EPS: f64 = 0.002;

/// The position key with each colour's tokens sorted: two moves of different but interchangeable tokens
/// (two tokens leaving base, two tokens on one square) lead to the same position.
fn canon_key(t: &Game) -> crate::search::Key {
    let mut k = leaf_key(t);
    for j in 0..t.b.n {
        k[36 + 4 * j..40 + 4 * j].sort_unstable();
    }
    k
}

/// Paired mean and standard error of res[c] - res[d] over their common playouts.
fn paired(a: &[f64], b: &[f64]) -> (f64, f64) {
    let n = a.len().min(b.len());
    let mean = (0..n).map(|i| a[i] - b[i]).sum::<f64>() / n as f64;
    let var = (0..n).map(|i| (a[i] - b[i] - mean).powi(2)).sum::<f64>() / (n.max(2) - 1) as f64;
    (mean, (var / n as f64).sqrt())
}

/// The rollout player with adaptive playouts (successive elimination, a racing bandit): the distinct
/// candidates (by canon_key) are played out in rounds of BATCH paired playouts (playout i of every
/// candidate on the same dice streams, as in evaluate); after each round a candidate whose paired deficit
/// to the leader exceeds Z_DROP standard errors stops, and the race ends with one candidate left, a near
/// tie (EPS), or `nmax` playouts each. Base's move is left only on a significant (Z) paired advantage,
/// as in choose. Clear decisions cost a few rounds, so the playouts go to the close ones.
///
/// `mine` plays the mover's own colours in the playouts (base plays everyone else): a stronger policy of
/// one's own than base values the candidates as "I keep playing well", not "I play like base from here".
pub fn choose_race(g: &Game, rng: &mut Rng, nmax: usize, cut: u32, eval: Option<&Evaluator>, base: &Policy, mine: &Policy) -> usize {
    if g.moves.len() == 1 {
        return 0;
    }
    let me = g.b.p[g.current].owner;
    let seed = (rng.next() * 2_147_483_647.0) as i64;
    let kb = base.choose(g, &mut Rng::seeded(seed ^ 0x0bad_5eed));
    let mut cands: Vec<(usize, Game)> = Vec::new();
    let mut keys = Vec::new();
    let mut b = 0;
    for k in 0..g.moves.len() {
        let mut t = *g;
        t.play(&g.moves.m[k]);
        let key = canon_key(&t);
        let pos = match keys.iter().position(|x| *x == key) {
            Some(p) => p,
            None => {
                keys.push(key);
                cands.push((k, t));
                keys.len() - 1
            }
        };
        if k == kb {
            b = pos;
        }
    }
    if cands.len() == 1 {
        return kb;
    }
    let nc = cands.len();
    let mut res: Vec<Vec<f64>> = vec![Vec::with_capacity(nmax); nc];
    let mut active: Vec<usize> = (0..nc).collect();
    let mut n = 0;
    let mean = |r: &Vec<f64>| r.iter().sum::<f64>() / r.len() as f64;
    while n < nmax && active.len() > 1 {
        let m = BATCH.min(nmax - n);
        let mut jobs = Vec::with_capacity(m * active.len());
        for i in n..n + m {
            let s = seed.wrapping_mul(7919).wrapping_add(i as i64);
            for &c in &active {
                jobs.push(Job { start: cands[c].1, seed: s, me });
            }
        }
        let out = backend().run(&jobs, cut, eval, base, mine);
        for (j, &c) in (0..m).flat_map(|_| active.iter()).enumerate() {
            res[c].push(out[j]);
        }
        n += m;
        let lead = *active.iter().max_by(|&&x, &&y| mean(&res[x]).partial_cmp(&mean(&res[y])).unwrap()).unwrap();
        let stats: Vec<(usize, f64, f64)> = active.iter().filter(|&&c| c != lead).map(|&c| {
            let (mu, se) = paired(&res[c], &res[lead]);
            (c, mu, se)
        }).collect();
        if stats.iter().all(|&(_, mu, se)| mu.abs() + 2.0 * se < EPS) {
            break;
        }
        if n >= 2 * BATCH {
            active.retain(|&c| c == lead || stats.iter().any(|&(d, mu, se)| d == c && mu + Z_DROP * se >= 0.0));
        }
    }
    let lead = *active.iter().max_by(|&&x, &&y| mean(&res[x]).partial_cmp(&mean(&res[y])).unwrap()).unwrap();
    let pick = if lead == b {
        b
    } else if !active.contains(&b) {
        lead // base's move dropped out: some candidate beat it by Z_DROP > Z standard errors
    } else {
        let (mu, se) = paired(&res[lead], &res[b]);
        if mu > Z * se { lead } else { b }
    };
    if std::env::var_os("LUDO_ROLLOUT_DEBUG").is_some() {
        eprintln!("RACE me {me} moves {} cands {nc} base {b} pick {pick} n {n} left {} playouts {}", g.moves.len(), active.len(), res.iter().map(|r| r.len()).sum::<usize>());
    }
    if pick == b { kb } else { cands[pick].0 }
}
