//! GPU leaf evaluator vs the CPU: every bit of every chance, on the search leaves of real games.
//!   gpu-check --net net.json [--games 40] [--seed 1] [--reps 3]
//! Plays games (every mode, Hard moves), collects the leaves of a depth-2 search at each decision, values
//! them with eval::batch_values on the CPU and on the GPU, and compares. Then times both on that batch.
use ludo_sim::bot::{choose_move, Level};
use ludo_sim::dice::roll_face;
use ludo_sim::eval::{batch_values, use_gpu, Evaluator};
use ludo_sim::game::{Game, PHASE_OVER, PHASE_ROLL};
use ludo_sim::rng::{Rng, Streams};
use ludo_sim::rules::MoveList;
use ludo_sim::search::{collect_leaves, SearchOptions};
use ludo_sim::trace::modes;
use std::collections::HashMap;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut flags: HashMap<String, String> = HashMap::new();
    let mut i = 1;
    while i + 1 < args.len() {
        flags.insert(args[i].trim_start_matches("--").to_string(), args[i + 1].clone());
        i += 2;
    }
    let net_path = flags.get("net").expect("--net");
    let games: usize = flags.get("games").map(|s| s.parse().unwrap()).unwrap_or(40);
    let seed: i64 = flags.get("seed").map(|s| s.parse().unwrap()).unwrap_or(1);
    let reps: usize = flags.get("reps").map(|s| s.parse().unwrap()).unwrap_or(3);
    let eval = Evaluator::from_json_text(&std::fs::read_to_string(net_path).unwrap());
    let opts = SearchOptions { depth: 2, chance: 2, their_k: 3, race: false, cut: 0.0 };

    let all = modes();
    let mut leaves: Vec<Vec<Game>> = Vec::new();
    for g in 0..games {
        let game_seed = seed * 1_000_003 + g as i64;
        let (_, seats, singles) = &all[g % all.len()];
        let mut gm = Game::new(seats, *singles);
        let mut rng = Rng::seeded(game_seed);
        gm.current = ((rng.next() * 4.0).floor() as usize) % seats.len();
        let mut st = Streams::new(rng, game_seed, ludo_sim::rng::FORMAT);
        let mut ml = MoveList::new();
        let mut steps = 0;
        while gm.phase != PHASE_OVER && steps < 50000 {
            if gm.phase == PHASE_ROLL {
                let f = roll_face(&gm.b, gm.current_color(), st.dice(), gm.singles, &mut ml);
                gm.roll(f);
            } else {
                if gm.moves.len() > 1 && steps % 7 == 0 {
                    leaves.push(collect_leaves(&eval, &gm, opts));
                }
                let k = choose_move(&gm, Level::Hard, &mut st.rng);
                let m = gm.moves.m[k];
                gm.play(&m);
            }
            steps += 1;
        }
    }
    let evals: Vec<&Evaluator> = vec![&eval; leaves.len()];
    let n: usize = leaves.iter().map(|l| l.len()).sum();
    println!("positions {n} from {} decisions", leaves.len());

    use_gpu(false);
    let cpu = batch_values(&evals, &leaves);
    use_gpu(true);
    let gpu = batch_values(&evals, &leaves);
    let mut bad = 0usize;
    let mut worst = 0.0f64;
    for (a, b) in cpu.iter().flatten().zip(gpu.iter().flatten()) {
        for o in 0..4 {
            if a[o].to_bits() != b[o].to_bits() {
                if bad < 5 {
                    println!("MISMATCH {:?} vs {:?}", a, b);
                }
                bad += 1;
                worst = worst.max((a[o] - b[o]).abs());
            }
        }
    }
    println!("PARITY values {} mismatched {bad} worst {worst:e}", n * 4);

    for (name, on) in [("cpu", false), ("gpu", true)] {
        use_gpu(on);
        let mut best = f64::INFINITY;
        for _ in 0..reps {
            let t = Instant::now();
            let _ = batch_values(&evals, &leaves);
            best = best.min(t.elapsed().as_secs_f64());
        }
        println!("TIME {name} {:.1} ms for {n} positions = {:.0} positions/s", best * 1e3, n as f64 / best);
    }
}
