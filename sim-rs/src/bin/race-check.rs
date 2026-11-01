//! Checks the race database against the real engine: random v1 race positions (every token in a home
//! column), played to the end with fair dice by every colour following the database's own move choice,
//! and the observed first-place rates compared with race_chances.
//!   race-check [positions] [games per position]
use ludo_sim::game::{Game, PHASE_OVER, PHASE_ROLL};
use ludo_sim::race::{race_chances, race_move};
use ludo_sim::rng::Rng;
use ludo_sim::trace::modes;
use rayon::prelude::*;

fn main() {
    let npos: usize = std::env::args().nth(1).map(|s| s.parse().unwrap()).unwrap_or(40);
    let games: usize = std::env::args().nth(2).map(|s| s.parse().unwrap()).unwrap_or(20000);
    let ms = modes();
    let mut worst_z: f64 = 0.0;
    for k in 0..npos {
        let (name, seats, singles) = &ms[[0, 2, 3, 4][k % 4]];
        let mut rng = Rng::seeded(1000 + k as i64);
        let mut g = Game::new(seats, *singles);
        for i in 0..g.b.n {
            for t in 0..4 {
                // mostly in the home column, some finished
                let r = rng.next();
                g.b.p[i].tokens[t] = if r < 0.2 { 56 } else { 51 + (rng.next() * 5.0).floor() as i8 };
            }
            if g.b.p[i].tokens.iter().all(|&t| t == 56) {
                g.b.p[i].tokens[0] = 51;
            }
        }
        g.current = (rng.next() * g.b.n as f64).floor() as usize;
        let pred = race_chances(&g).expect("a v1 race position");
        let people = seats.iter().map(|s| s.1).max().unwrap() as usize + 1;
        let wins: Vec<[u64; 4]> = (0..games)
            .into_par_iter()
            .map(|s| {
                let mut r = Rng::seeded((k * 1_000_003 + s) as i64);
                let mut t = g;
                let mut steps = 0;
                while t.phase != PHASE_OVER && steps < 100000 {
                    if t.phase == PHASE_ROLL {
                        t.roll((r.next() * 6.0).floor() as u8 + 1);
                    } else {
                        let m = t.moves.m[race_move(&t)];
                        t.play(&m);
                    }
                    steps += 1;
                }
                let mut w = [0u64; 4];
                w[t.owner_ranking()[0] as usize] = 1;
                w
            })
            .collect();
        let mut line = format!("{name:12} ");
        for p in 0..people {
            let obs = wins.iter().map(|w| w[p]).sum::<u64>() as f64 / games as f64;
            let se = (pred[p] * (1.0 - pred[p]) / games as f64).sqrt().max(1e-9);
            let z = (obs - pred[p]) / se;
            worst_z = worst_z.max(z.abs());
            line += &format!("p{p} db {:.4} sim {:.4} (z {:+.1})  ", pred[p], obs, z);
        }
        println!("{line}");
    }
    println!("RACE-CHECK worst |z| {worst_z:.2} over {npos} positions x {games} games");
}
