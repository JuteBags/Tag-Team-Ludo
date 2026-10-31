//! tools/ai/arena.ts in Rust: policy A against policy B on paired seeds, the same games and the same
//! ARENA JSON line (seeds run in parallel; the counts are sums, so the order does not matter).
//!   ludo-arena --a net:rules.json:1 --b hard --mode 2p --from 0 --to 5000 [--threads N] [--format 2]
//!              [--aivat <weights.json> [--aivat-chance 1]]
//! --aivat adds a luck-corrected win count (AIVAT, Burch et al. 2017): each game's result minus the
//! dice luck at every roll, luck = V(after the face rolled) - sum_f p(f) V(after face f), with p the
//! distribution that roll was actually drawn from and V the given evaluator's chance that A's person
//! wins. Each luck term has mean zero, so the corrected rate is unbiased for any V; a good V removes
//! most of the dice noise. Measurement only: the players never see p or V. Only totals are printed.
//! V(after a face) is a depth-1 search with the evaluator (--aivat-chance extra rolls looked at), since a
//! face's luck shows only once the turn it allows is played. It costs six searches per roll, so it pays
//! only when the players' own moves are already expensive (net / depth-2 matches); for cheap rule-bot
//! matches the extra cost outweighs the fewer games (laptop, 2p, linear V: 2.5x lower variance at 10x
//! the cost per game).
use ludo_sim::bot::Policy;
use ludo_sim::dice::{sample_face, weights};
use ludo_sim::eval::Evaluator;
use ludo_sim::game::{Game, PHASE_OVER, PHASE_ROLL};
use ludo_sim::rng::{Rng, Streams};
use ludo_sim::rules::MoveList;
use ludo_sim::trace::modes;
use rayon::prelude::*;
use std::collections::HashMap;
use std::time::Instant;

/// V for AIVAT: person `who`'s chance of winning after a face is rolled, valued by a depth-1 search with
/// `eval` (the roller plans the turn those dice allow; a face's luck shows only once it is played).
fn value(eval: &Evaluator, g: &Game, who: usize, chance: u32) -> f64 {
    if g.phase == PHASE_OVER {
        return if g.owner_ranking()[0] as usize == who { 1.0 } else { 0.0 };
    }
    let opts = ludo_sim::search::SearchOptions { depth: 1, chance, their_k: 3, race: false };
    ludo_sim::search::state_values(eval, g, opts)[who]
}

/// common.ts playGame: `by_owner[o]` plays person o's colours, `first` is the starting colour index.
/// With `aivat` = (V, person), also returns the summed dice luck for that person.
pub fn play_game(seats: &[(u8, u8)], singles: bool, by_owner: &[&Policy], st: &mut Streams, first: usize, aivat: Option<(&Evaluator, usize, u32)>) -> (Game, f64) {
    let mut g = Game::new(seats, singles);
    g.current = first % seats.len();
    let mut ml = MoveList::new();
    let mut steps = 0;
    let mut luck = 0.0;
    while g.phase != PHASE_OVER && steps < 50000 {
        if g.phase == PHASE_ROLL {
            // roll_face, split so the distribution of this roll is known (same draws, same order)
            let w = weights(&g.b, g.current_color(), st.dice(), g.singles, &mut ml);
            let f = sample_face(&w, st.dice());
            if let Some((eval, who, chance)) = aivat {
                let mut expect = 0.0;
                let mut actual = 0.0;
                for face in 1..=6u8 {
                    let mut t = g;
                    t.roll(face);
                    let v = value(eval, &t, who, chance);
                    expect += w[face as usize - 1] * v;
                    if face == f {
                        actual = v;
                    }
                }
                luck += actual - expect;
            }
            g.roll(f);
        } else {
            let k = by_owner[g.b.p[g.current].owner as usize].choose(&g, &mut st.rng);
            let m = g.moves.m[k];
            g.play(&m);
        }
        steps += 1;
    }
    (g, luck)
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
    let format: u32 = flags.get("format").map(|s| s.parse().unwrap()).unwrap_or(ludo_sim::rng::FORMAT);
    let aivat: Option<Evaluator> = flags.get("aivat").filter(|p| !p.is_empty()).map(|p| Evaluator::from_json_text(&std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{p}: {e}"))));
    let aivat_chance: u32 = flags.get("aivat-chance").map(|s| s.parse().unwrap()).unwrap_or(1);
    let t0 = Instant::now();
    // per seed: (games, wins, placeSum, seedWins^2, firstGames, firstWins), (corrected wins, its square)
    let per: Vec<([i64; 6], f64, f64)> = (from..to)
        .into_par_iter()
        .map(|seed| {
            let mut r = [0i64; 6];
            let mut seed_wins = 0;
            let mut seed_corr = 0.0f64;
            for seat in 0..people {
                let mut st = Streams::new(Rng::seeded(seed * 7919 + 13), seed * 7919 + 13, format);
                let by_owner: Vec<&Policy> = (0..people).map(|o| if o == seat { &a } else { &b }).collect();
                let first = (seed % 4) as usize;
                let (end, luck) = play_game(&seats, singles, &by_owner, &mut st, first, aivat.as_ref().map(|e| (e, seat, aivat_chance)));
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
                seed_corr += (place == 1) as i64 as f64 - luck;
            }
            r[1] = seed_wins;
            r[3] = seed_wins * seed_wins;
            (r, seed_corr, seed_corr * seed_corr)
        })
        .collect();
    let mut s = [0i64; 6];
    let (mut corr, mut corr_sq) = (0.0f64, 0.0f64);
    for (r, c, c2) in &per {
        for k in 0..6 {
            s[k] += r[k];
        }
        corr += c;
        corr_sq += c2;
    }
    let seeds = per.len();
    let q = |x: &str| x.replace('\\', "\\\\").replace('"', "\\\"");
    println!(
        "ARENA {{\"a\":\"{}\",\"b\":\"{}\",\"mode\":\"{}\",\"people\":{people},\"games\":{},\"wins\":{},\"placeSum\":{},\"seeds\":{seeds},\"seedSq\":{},\"firstGames\":{},\"firstWins\":{}{},\"ms\":{}}}",
        q(&a_spec),
        q(&b_spec),
        mode,
        s[0],
        s[1],
        s[2],
        s[3],
        s[4],
        s[5],
        if aivat.is_some() { format!(",\"aivatWins\":{corr},\"aivatSeedSq\":{corr_sq}") } else { String::new() },
        t0.elapsed().as_millis()
    );
}
