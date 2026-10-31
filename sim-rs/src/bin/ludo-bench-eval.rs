//! Micro-benchmark of the leaf evaluation (encode + net) and of one search per decision, on positions
//! from real games:  ludo-bench-eval net.json [positions]
use ludo_sim::bot::Policy;
use ludo_sim::dice::roll_face;
use ludo_sim::encode::{encode, D};
use ludo_sim::eval::Evaluator;
use ludo_sim::game::{Game, PHASE_OVER, PHASE_ROLL};
use ludo_sim::rng::Rng;
use ludo_sim::rules::MoveList;
use ludo_sim::search::{search_values, SearchOptions};
use ludo_sim::trace::modes;
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).expect("net.json");
    let n: usize = std::env::args().nth(2).map(|s| s.parse().unwrap()).unwrap_or(20000);
    let eval = Evaluator::from_json_text(&std::fs::read_to_string(&path).unwrap());
    let ms = modes();
    let hard = Policy::parse("hard");
    let (mut rolls, mut moves): (Vec<Game>, Vec<Game>) = (Vec::new(), Vec::new());
    let mut seed = 1i64;
    while rolls.len() < n {
        let (_, seats, singles) = &ms[(seed % 3) as usize];
        let mut rng = Rng::seeded(seed);
        let mut dice = Rng::seeded(seed ^ 77);
        let mut g = Game::new(seats, *singles);
        let mut ml = MoveList::new();
        while g.phase != PHASE_OVER {
            if g.phase == PHASE_ROLL {
                rolls.push(g);
                let f = roll_face(&g.b, g.current_color(), &mut dice, g.singles, &mut ml);
                g.roll(f);
            } else {
                if g.moves.len() > 1 {
                    moves.push(g);
                }
                let k = hard.choose(&g, &mut rng);
                let m = g.moves.m[k];
                g.play(&m);
            }
        }
        seed += 1;
    }
    let mut x = [0.0f64; 4 * D];
    let t = Instant::now();
    let mut acc = 0.0;
    for g in &rolls[..n] {
        encode(&g.b, g.current, g.singles, g.tray(), g.sixes, &mut x);
        acc += x[5];
    }
    let enc = t.elapsed().as_secs_f64() / n as f64;
    let t = Instant::now();
    let mut v = [0.0f64; 4];
    for g in &rolls[..n] {
        eval.owner_chances(g, &mut v);
        acc += v[0];
    }
    let ev = t.elapsed().as_secs_f64() / n as f64;
    let m = moves.len().min(2000);
    let t = Instant::now();
    for g in &moves[..m] {
        let vals = search_values(&eval, g, SearchOptions::default());
        acc += vals[0];
    }
    let se = t.elapsed().as_secs_f64() / m as f64;
    let t = Instant::now();
    let mut y = 0.0;
    for i in 0..1_000_000 {
        y += ludo_sim::jsmath::tanh((i % 2000) as f64 * 0.003 - 3.0);
    }
    let th = t.elapsed().as_secs_f64() / 1e6;
    println!("tanh {:.1} ns ({y:.1})", th * 1e9);
    println!("encode {:.2} us | owner_chances {:.2} us | depth-1 search per decision {:.1} us ({:.0} evals-equivalent) | {acc:.3}", enc * 1e6, ev * 1e6, se * 1e6, se / ev);
}

#[allow(dead_code)]
fn _unused() {}
