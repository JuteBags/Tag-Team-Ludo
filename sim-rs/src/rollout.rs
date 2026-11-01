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

fn playout(mut g: Game, base: &Policy, me: u8, dice: &mut [Rng; 4], rng: &mut Rng, cut: u32, eval: Option<&Evaluator>) -> f64 {
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
            let k = base.choose(&g, rng);
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
    if nm == 1 {
        return 0;
    }
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
            res[c][i] = playout(*t, base, me, &mut d, &mut r, cut, eval);
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
