//! Monte Carlo rollout player: at each decision, every distinct legal move is played out `n` times with
//! every seat (its own included) played by `base` afterwards, on FAIR dice, and the move with the highest
//! mean result for the mover's person is chosen. Common random numbers: playout i of every candidate uses
//! the same dice and policy streams, so the candidates' differences carry little dice noise. With
//! `cut` > 0 a playout stops after `cut` turn changes and is scored by `eval`'s chance for the mover's
//! person (at the next position before a roll); with `cut` = 0 it runs to the end (1 if the person finishes
//! first, else 0). Measurement and ceiling tool (it approximates the best response to `base`); far too
//! slow for the app as it stands.
use crate::bot::Policy;
use crate::dice::{sample_face, FAIR};
use crate::eval::Evaluator;
use crate::game::{Game, PHASE_OVER, PHASE_ROLL};
use crate::rng::Rng;
use crate::search::leaf_key;

fn playout(mut g: Game, base: &Policy, me: u8, dice: &mut Rng, rng: &mut Rng, cut: u32, eval: Option<&Evaluator>) -> f64 {
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
            let f = sample_face(&FAIR, dice);
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

/// The rollout player's choice (an index into g.moves). Draws one number from `rng` per decision.
pub fn choose(g: &Game, rng: &mut Rng, n: usize, cut: u32, eval: Option<&Evaluator>, base: &Policy) -> usize {
    let nm = g.moves.len();
    if nm == 1 {
        return 0;
    }
    let me = g.b.p[g.current].owner;
    let seed = (rng.next() * 2_147_483_647.0) as i64;
    // distinct resulting positions only (two moves can lead to the same position)
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
    if cands.len() == 1 {
        return cands[0].0;
    }
    let mut score = vec![0.0f64; cands.len()];
    for i in 0..n {
        let s = seed.wrapping_mul(7919).wrapping_add(i as i64);
        for (c, (_, t)) in cands.iter().enumerate() {
            let mut d = Rng::seeded(s);
            let mut r = Rng::seeded(s ^ 0x1234_5678);
            score[c] += playout(*t, base, me, &mut d, &mut r, cut, eval);
        }
    }
    // Start from the base policy's own move and leave it only for a strictly better mean: with common
    // random numbers many candidates tie exactly, and a tie must not fall to whichever move is listed first.
    let kb = base.choose(g, &mut Rng::seeded(seed ^ 0x0bad_5eed));
    let mut t = *g;
    t.play(&g.moves.m[kb]);
    let kkey = leaf_key(&t);
    let mut best = keys.iter().position(|k| *k == kkey).unwrap_or(0);
    for c in 0..cands.len() {
        if score[c] > score[best] {
            best = c;
        }
    }
    if std::env::var_os("LUDO_ROLLOUT_DEBUG").is_some() {
        eprintln!("ROLLOUT me {me} moves {nm} cands {} scores {:?} pick {best}", cands.len(), score);
    }
    cands[best].0
}
