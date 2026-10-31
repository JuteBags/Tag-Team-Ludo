//! Where the net and readable rules choose differently, and who is right: disagreement mining on FAIR dice.
//!   ludo-disagree --a net:gen1.json --b net:hard2.json:1 --games 400 --keep 0.25 --rollouts 20
//!                 [--rollout net:gen1.json:1:3:0:0:1:0.01] [--modes 2p,4p] [--seed 1] [--threads N] --out d.jsonl
//! Positions come from A-vs-B games (seats alternate by game, fair dice). At a kept decision (several legal
//! moves, kept with probability --keep) both A and B choose; where they differ, each of the two moves is
//! played out --rollouts times with the same dice and policy streams for both branches (paired), every
//! seat played by --rollout afterwards, and the mover's person wins if it finishes first. One JSON line
//! per disagreement: the position (trace state key), the two moves, each move's rollout wins, A's search
//! value of each move, and the mover's readable rule features (encode.rs FEATURE_NAMES) after each move.
use ludo_sim::bot::Policy;
use ludo_sim::dice::{sample_face, FAIR};
use ludo_sim::encode::{features, F, FEATURE_NAMES};
use ludo_sim::eval::Evaluator;
use ludo_sim::game::{Game, PHASE_OVER, PHASE_ROLL};
use ludo_sim::rng::Rng;
use ludo_sim::trace::{modes, move_key, state_key};
use rayon::prelude::*;
use std::collections::HashMap;
use std::fmt::Write as _;
use std::io::Write;

/// The rest of a game from `g`, every seat played by `p`; the dice and the policy draw from their own
/// streams. True if `who` (a person) finishes first.
fn rollout(mut g: Game, p: &Policy, who: u8, dice: &mut Rng, rng: &mut Rng) -> bool {
    let mut steps = 0;
    while g.phase != PHASE_OVER && steps < 50000 {
        if g.phase == PHASE_ROLL {
            let f = sample_face(&FAIR, dice);
            g.roll(f);
        } else {
            let k = p.choose(&g, rng);
            let m = g.moves.m[k];
            g.play(&m);
        }
        steps += 1;
    }
    g.phase == PHASE_OVER && g.owner_ranking()[0] == who
}

/// The mover's summed feature vector (its person's colours) after a move.
fn mover_features(g: &Game, who: u8) -> [f64; F] {
    let mut f = [0.0f64; 4 * F];
    features(&g.b, g.current, g.singles, &mut f);
    let mut out = [0.0f64; F];
    for (i, p) in g.b.players().iter().enumerate() {
        if p.owner == who {
            for k in 0..F {
                out[k] += f[i * F + k];
            }
        }
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut flags: HashMap<String, String> = HashMap::new();
    let mut i = 1;
    while i + 1 < args.len() {
        flags.insert(args[i].trim_start_matches("--").to_string(), args[i + 1].clone());
        i += 2;
    }
    if let Some(t) = flags.get("threads") {
        rayon::ThreadPoolBuilder::new().num_threads(t.parse().unwrap()).build_global().unwrap();
    }
    let spec_a = flags.get("a").expect("--a").clone();
    let spec_b = flags.get("b").expect("--b").clone();
    let games: usize = flags.get("games").map(|s| s.parse().unwrap()).unwrap_or(400);
    let keep: f64 = flags.get("keep").map(|s| s.parse().unwrap()).unwrap_or(0.25);
    let n_roll: usize = flags.get("rollouts").map(|s| s.parse().unwrap()).unwrap_or(20);
    let seed: i64 = flags.get("seed").map(|s| s.parse().unwrap()).unwrap_or(1);
    let spec_r = flags.get("rollout").cloned().unwrap_or_else(|| spec_a.clone());
    let out_path = flags.get("out").cloned().unwrap_or_else(|| "disagree.jsonl".into());
    let all = modes();
    let mode_list: Vec<_> = flags
        .get("modes")
        .map(|m| m.as_str())
        .unwrap_or("2p,4p")
        .split(',')
        .map(|n| all.iter().find(|x| x.0 == n).unwrap_or_else(|| panic!("unknown mode {n}")).clone())
        .collect();
    let (pa, pb, pr) = (Policy::parse(&spec_a), Policy::parse(&spec_b), Policy::parse(&spec_r));
    // A's search values of each move (its evaluator and options)
    let a_eval: Option<(std::sync::Arc<Evaluator>, ludo_sim::search::SearchOptions)> = match &pa {
        Policy::Search { eval, opts, .. } => Some((eval.clone(), *opts)),
        _ => None,
    };

    let t0 = std::time::Instant::now();
    let lines: Vec<String> = (0..games)
        .into_par_iter()
        .flat_map_iter(|gi| {
            let game_seed = seed * 1_000_003 + gi as i64;
            let (mode, seats, singles) = &mode_list[gi % mode_list.len()];
            let people = seats.iter().map(|s| s.1).max().unwrap() as usize + 1;
            let a_person = (gi / mode_list.len()) % people; // A's seat rotates over games
            let mut g = Game::new(seats, *singles);
            g.current = gi % seats.len();
            let mut dice = Rng::seeded(((game_seed as u32) ^ 0x2545_f491) as i64);
            let mut rng = Rng::seeded(game_seed);
            let mut pick = Rng::seeded(((game_seed as u32) ^ 0x5bd1_e995) as i64);
            let mut out = Vec::new();
            let mut steps = 0;
            let mut decision = 0usize;
            while g.phase != PHASE_OVER && steps < 50000 {
                if g.phase == PHASE_ROLL {
                    let f = sample_face(&FAIR, &mut dice);
                    g.roll(f);
                    steps += 1;
                    continue;
                }
                let who = g.b.p[g.current].owner;
                let mine = who as usize == a_person;
                if g.moves.len() > 1 && pick.next() < keep {
                    let mut ra = Rng::seeded(game_seed * 31 + decision as i64);
                    let mut rb = Rng::seeded(game_seed * 31 + decision as i64);
                    let ka = pa.choose(&g, &mut ra);
                    let kb = pb.choose(&g, &mut rb);
                    if ka != kb {
                        let (ma, mb) = (g.moves.m[ka], g.moves.m[kb]);
                        let (mut ga, mut gb) = (g, g);
                        ga.play(&ma);
                        gb.play(&mb);
                        let (mut wa, mut wb) = (0usize, 0usize);
                        for r in 0..n_roll {
                            let s = game_seed * 7919 + (decision * 1000 + r) as i64;
                            let (mut d1, mut r1) = (Rng::seeded(s), Rng::seeded(s ^ 0x1234_5678));
                            let (mut d2, mut r2) = (Rng::seeded(s), Rng::seeded(s ^ 0x1234_5678));
                            wa += rollout(ga, &pr, who, &mut d1, &mut r1) as usize;
                            wb += rollout(gb, &pr, who, &mut d2, &mut r2) as usize;
                        }
                        let vals = a_eval.as_ref().map(|(e, o)| ludo_sim::search::search_values(e, &g, *o));
                        let (fa, fb) = (mover_features(&ga, who), mover_features(&gb, who));
                        let mut key = String::new();
                        state_key(&g, &mut key);
                        let (mut ka_s, mut kb_s) = (String::new(), String::new());
                        move_key(&ma, &mut ka_s);
                        move_key(&mb, &mut kb_s);
                        let mut l = String::new();
                        write!(l, "{{\"game\":{gi},\"mode\":\"{mode}\",\"mover_is_a\":{mine},\"tray\":{:?},\"state\":\"{key}\",\"a_move\":\"{ka_s}\",\"b_move\":\"{kb_s}\",\"rollouts\":{n_roll},\"a_wins\":{wa},\"b_wins\":{wb}", g.tray()).unwrap();
                        if let Some(v) = &vals {
                            write!(l, ",\"a_value_a\":{},\"a_value_b\":{}", v[ka], v[kb]).unwrap();
                        }
                        l.push_str(",\"features_after_a\":{");
                        for k in 0..F {
                            write!(l, "{}\"{}\":{}", if k > 0 { "," } else { "" }, FEATURE_NAMES[k], fa[k]).unwrap();
                        }
                        l.push_str("},\"features_after_b\":{");
                        for k in 0..F {
                            write!(l, "{}\"{}\":{}", if k > 0 { "," } else { "" }, FEATURE_NAMES[k], fb[k]).unwrap();
                        }
                        l.push_str("}}");
                        out.push(l);
                    }
                }
                decision += 1;
                // the game itself goes on with the seat's own policy
                let k = if mine { pa.choose(&g, &mut rng) } else { pb.choose(&g, &mut rng) };
                let m = g.moves.m[k];
                g.play(&m);
                steps += 1;
            }
            out
        })
        .collect();
    let mut f = std::io::BufWriter::new(std::fs::File::create(&out_path).unwrap());
    for l in &lines {
        writeln!(f, "{l}").unwrap();
    }
    f.flush().unwrap();
    println!("DISAGREE games {games} disagreements {} rollouts {} secs {:.0} -> {out_path}", lines.len(), lines.len() * 2 * n_roll, t0.elapsed().as_secs_f64());
}
