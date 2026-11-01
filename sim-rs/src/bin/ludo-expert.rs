//! Expert data for training on PAIRED move comparisons (expert iteration), FAIR dice.
//!   ludo-expert --expert rollout:<n>:<cut>:<eval.json>:<base spec> --opp net:hard2.json:1 --games 1000
//!               [--modes 4p] [--seed 1] [--threads N] [--all-seats 1] --out expert-0.bin
//! Games: the expert in one house (rotating by game), --opp everywhere else. At a logged decision (the
//! expert's, or every seat's with --all-seats 1; several distinct moves; every candidate leads to a position
//! before a roll, the kind the depth-1 search compares) every candidate's resulting position is written with
//! its paired playout mean for the mover (rollout.rs evaluate: same per-seat dice for every candidate).
//! The seat then plays its own policy (the expert its pick, the others --opp).
//! File: u32 header length, JSON header {v, kind: "expert", D, rows, groups, expert, opp, ...}, then
//! float32 X [rows, 4, D] (encode.rs, from the position's current colour), int32 owner [rows, 4] (-1 = no
//! colour), int32 group [rows], int32 mover [rows] (the deciding person), float32 mean [rows].
use ludo_sim::bot::Policy;
use ludo_sim::dice::{sample_face, FAIR};
use ludo_sim::encode::{encode, D};
use ludo_sim::game::{Game, PHASE_OVER, PHASE_ROLL};
use ludo_sim::rng::Rng;
use ludo_sim::trace::modes;
use rayon::prelude::*;
use std::collections::HashMap;
use std::io::Write;

struct Row {
    x: Vec<f32>,
    owner: [i32; 4],
    mover: i32,
    mean: f32,
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
    let expert_spec = flags.get("expert").expect("--expert rollout:...").clone();
    let opp_spec = flags.get("opp").expect("--opp").clone();
    let games: usize = flags.get("games").map(|s| s.parse().unwrap()).unwrap_or(1000);
    let seed: i64 = flags.get("seed").map(|s| s.parse().unwrap()).unwrap_or(1);
    let all_seats = flags.get("all-seats").map(|s| s == "1").unwrap_or(false);
    let out_path = flags.get("out").cloned().unwrap_or_else(|| "expert.bin".into());
    let all = modes();
    let mode_list: Vec<_> = flags
        .get("modes")
        .map(|m| m.as_str())
        .unwrap_or("4p")
        .split(',')
        .map(|n| all.iter().find(|x| x.0 == n).unwrap_or_else(|| panic!("unknown mode {n}")).clone())
        .collect();
    let expert = Policy::parse(&expert_spec);
    let (n, cut, eval, base) = match &expert {
        Policy::Rollout { n, cut, eval, base } => (*n, *cut, eval.clone(), (**base).clone()),
        _ => panic!("--expert must be a rollout: spec"),
    };
    let opp = Policy::parse(&opp_spec);

    let t0 = std::time::Instant::now();
    let groups: Vec<Vec<Row>> = (0..games)
        .into_par_iter()
        .flat_map_iter(|gi| {
            let game_seed = seed * 1_000_003 + gi as i64;
            let (_, seats, singles) = &mode_list[gi % mode_list.len()];
            let people = seats.iter().map(|s| s.1).max().unwrap() as usize + 1;
            let x_person = (gi / mode_list.len()) % people;
            let mut g = Game::new(seats, *singles);
            g.current = gi % seats.len();
            let mut dice = Rng::seeded(((game_seed as u32) ^ 0x2545_f491) as i64);
            let mut rng = Rng::seeded(game_seed);
            let mut out: Vec<Vec<Row>> = Vec::new();
            let mut steps = 0;
            while g.phase != PHASE_OVER && steps < 50000 {
                if g.phase == PHASE_ROLL {
                    let f = sample_face(&FAIR, &mut dice);
                    g.roll(f);
                    steps += 1;
                    continue;
                }
                let who = g.b.p[g.current].owner;
                let is_x = who as usize == x_person;
                let k = if g.moves.len() > 1 && (is_x || all_seats) {
                    let e = ludo_sim::rollout::evaluate(&g, &mut rng, n, cut, eval.as_deref(), &base);
                    let usable = e.cands.len() > 1 && e.cands.iter().all(|(_, t, m)| t.phase == PHASE_ROLL && m.is_finite());
                    if usable {
                        let mut grp = Vec::with_capacity(e.cands.len());
                        for (_, t, m) in &e.cands {
                            let mut x = [0.0f64; 4 * D];
                            encode(&t.b, t.current, t.singles, t.tray(), t.sixes, &mut x);
                            let mut owner = [-1i32; 4];
                            for (c, p) in t.b.players().iter().enumerate() {
                                owner[c] = p.owner as i32;
                            }
                            grp.push(Row { x: x.iter().map(|&v| v as f32).collect(), owner, mover: who as i32, mean: *m as f32 });
                        }
                        out.push(grp);
                    }
                    if is_x { e.cands[e.pick].0 } else { opp.choose(&g, &mut rng) }
                } else if is_x {
                    expert.choose(&g, &mut rng)
                } else {
                    opp.choose(&g, &mut rng)
                };
                let m = g.moves.m[k];
                g.play(&m);
                steps += 1;
            }
            out
        })
        .collect();
    let rows: usize = groups.iter().map(|g| g.len()).sum();
    let head = format!(
        "{{\"v\":1,\"kind\":\"expert\",\"D\":{D},\"rows\":{rows},\"groups\":{},\"games\":{games},\"seed\":{seed},\"expert\":\"{expert_spec}\",\"opp\":\"{opp_spec}\",\"all_seats\":{all_seats},\"dice\":\"fair\"}}",
        groups.len()
    );
    let mut f = std::io::BufWriter::new(std::fs::File::create(&out_path).unwrap());
    f.write_all(&(head.len() as u32).to_le_bytes()).unwrap();
    f.write_all(head.as_bytes()).unwrap();
    for g in &groups {
        for r in g {
            for v in &r.x {
                f.write_all(&v.to_le_bytes()).unwrap();
            }
        }
    }
    for g in &groups {
        for r in g {
            for v in r.owner {
                f.write_all(&v.to_le_bytes()).unwrap();
            }
        }
    }
    for (gi, g) in groups.iter().enumerate() {
        for _ in g {
            f.write_all(&(gi as i32).to_le_bytes()).unwrap();
        }
    }
    for g in &groups {
        for r in g {
            f.write_all(&r.mover.to_le_bytes()).unwrap();
        }
    }
    for g in &groups {
        for r in g {
            f.write_all(&r.mean.to_le_bytes()).unwrap();
        }
    }
    f.flush().unwrap();
    println!("EXPERT games {games} groups {} rows {rows} secs {:.0} -> {out_path}", groups.len(), t0.elapsed().as_secs_f64());
}
