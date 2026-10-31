//! tools/ai/arena.ts in Rust: policy A against policy B on paired seeds, the same games and the same
//! ARENA JSON line (seeds run in parallel; the counts are sums, so the order does not matter).
//!   ludo-arena --a net:rules.json:1 --b hard --mode 2p --from 0 --to 5000 [--threads N]
use ludo_sim::bot::Policy;
use ludo_sim::dice::roll_face;
use ludo_sim::game::{Game, PHASE_OVER, PHASE_ROLL};
use ludo_sim::rng::Rng;
use ludo_sim::rules::MoveList;
use ludo_sim::trace::modes;
use rayon::prelude::*;
use std::collections::HashMap;
use std::time::Instant;

/// common.ts playGame: `by_owner[o]` plays person o's colours, `first` is the starting colour index.
pub fn play_game(seats: &[(u8, u8)], singles: bool, by_owner: &[&Policy], rng: &mut Rng, first: usize) -> Game {
    let mut g = Game::new(seats, singles);
    g.current = first % seats.len();
    let mut ml = MoveList::new();
    let mut steps = 0;
    while g.phase != PHASE_OVER && steps < 50000 {
        if g.phase == PHASE_ROLL {
            let f = roll_face(&g.b, g.current_color(), rng, g.singles, &mut ml);
            g.roll(f);
        } else {
            let k = by_owner[g.b.p[g.current].owner as usize].choose(&g, rng);
            let m = g.moves.m[k];
            g.play(&m);
        }
        steps += 1;
    }
    g
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut flags: HashMap<String, String> = HashMap::new();
    let mut i = 1;
    while i < args.len() {
        if let Some(k) = args[i].strip_prefix("--") {
            let v = args.get(i + 1).filter(|v| !v.starts_with("--")).cloned().unwrap_or_default();
            if !v.is_empty() {
                i += 1;
            }
            flags.insert(k.to_string(), v);
        }
        i += 1;
    }
    if let Some(t) = flags.get("threads") {
        rayon::ThreadPoolBuilder::new().num_threads(t.parse().unwrap()).build_global().unwrap();
    }
    let a_spec = flags["a"].clone();
    let b_spec = flags["b"].clone();
    let a = Policy::parse(&a_spec);
    let b = Policy::parse(&b_spec);
    let mode = flags.get("mode").cloned().unwrap_or_else(|| "2p".into());
    let all = modes();
    let (_, seats, singles) = all.iter().find(|m| m.0 == mode).unwrap_or_else(|| panic!("unknown mode {mode}")).clone();
    let people = seats.iter().map(|s| s.1).max().unwrap() as usize + 1;
    let from: i64 = flags.get("from").map(|s| s.parse().unwrap()).unwrap_or(0);
    let to: i64 = flags.get("to").map(|s| s.parse().unwrap()).unwrap_or(1000);
    let t0 = Instant::now();
    // per seed: (games, wins, placeSum, seedWins^2, firstGames, firstWins)
    let per: Vec<[i64; 6]> = (from..to)
        .into_par_iter()
        .map(|seed| {
            let mut r = [0i64; 6];
            let mut seed_wins = 0;
            for seat in 0..people {
                let mut rng = Rng::seeded(seed * 7919 + 13);
                let by_owner: Vec<&Policy> = (0..people).map(|o| if o == seat { &a } else { &b }).collect();
                let first = (seed % 4) as usize;
                let end = play_game(&seats, singles, &by_owner, &mut rng, first);
                let place = end.owner_ranking().iter().position(|&o| o as usize == seat).map(|x| x as i64 + 1).unwrap_or(0);
                let is_first = end.b.p[first % end.b.n].owner as usize == seat;
                r[0] += 1;
                if is_first {
                    r[4] += 1;
                }
                if place == 1 {
                    seed_wins += 1;
                    if is_first {
                        r[5] += 1;
                    }
                }
                r[2] += place;
            }
            r[1] = seed_wins;
            r[3] = seed_wins * seed_wins;
            r
        })
        .collect();
    let mut s = [0i64; 6];
    for r in &per {
        for k in 0..6 {
            s[k] += r[k];
        }
    }
    let seeds = per.len();
    let q = |x: &str| x.replace('\\', "\\\\").replace('"', "\\\"");
    println!(
        "ARENA {{\"a\":\"{}\",\"b\":\"{}\",\"mode\":\"{}\",\"people\":{people},\"games\":{},\"wins\":{},\"placeSum\":{},\"seeds\":{seeds},\"seedSq\":{},\"firstGames\":{},\"firstWins\":{},\"ms\":{}}}",
        q(&a_spec),
        q(&b_spec),
        mode,
        s[0],
        s[1],
        s[2],
        s[3],
        s[4],
        s[5],
        t0.elapsed().as_millis()
    );
}
