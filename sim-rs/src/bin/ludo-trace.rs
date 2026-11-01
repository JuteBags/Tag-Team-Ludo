//! Same command line and output as tools/ai/trace.ts, multi-threaded:
//!   ludo-trace --games 1000 --seed 1 --out traces.jsonl [--full] [--modes 2p,4p,...]
//!              [--from 0] [--policies random,easy,normal,hard] [--threads N] [--format 2]
//! --format 1 replays the old traces (dice and policies on one stream); 2 (default) is common.ts FORMAT.
//! `--bench` plays the same games without building step lines (no hash) and prints games/s only.
use ludo_sim::bot::Policy;
use ludo_sim::trace::{json_line, modes, play_traced};
use rayon::prelude::*;
use std::collections::HashMap;
use std::io::Write;
use std::time::Instant;

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
    let games: u64 = flags.get("games").map(|s| s.parse().unwrap()).unwrap_or(1000);
    let seed: i64 = flags.get("seed").map(|s| s.parse().unwrap()).unwrap_or(1);
    let from: u64 = flags.get("from").map(|s| s.parse().unwrap()).unwrap_or(0);
    let format: u32 = flags.get("format").map(|s| s.parse().unwrap()).unwrap_or(ludo_sim::rng::FORMAT);
    let full = flags.contains_key("full");
    // --dice fair: every face 1 in 6; default: the app's dice
    let fair = flags.get("dice").map(|d| d == "fair").unwrap_or(false);
    let bench = flags.contains_key("bench");
    let all = modes();
    let mode_names: Vec<String> = match flags.get("modes") {
        Some(m) if !m.is_empty() => m.split(',').map(|s| s.to_string()).collect(),
        _ => all.iter().map(|m| m.0.clone()).collect(),
    };
    let mode_list: Vec<_> = mode_names.iter().map(|n| all.iter().find(|m| &m.0 == n).unwrap_or_else(|| panic!("unknown mode {n}")).clone()).collect();
    let policy_names: Vec<String> = flags.get("policies").filter(|s| !s.is_empty()).map(|s| s.as_str()).unwrap_or("random,easy,normal,hard").split(',').map(|s| s.to_string()).collect();
    if let Some(t) = flags.get("threads") {
        rayon::ThreadPoolBuilder::new().num_threads(t.parse().unwrap()).build_global().unwrap();
    }

    let t0 = Instant::now();
    let lines: Vec<String> = (from..from + games)
        .into_par_iter()
        .map(|g| {
            let game_seed = seed * 1_000_003 + g as i64;
            let (name, seats, singles) = &mode_list[(g as usize) % mode_list.len()];
            let people = seats.iter().map(|s| s.1).max().unwrap() as usize + 1;
            let specs: Vec<&str> = (0..people).map(|o| policy_names[(g as usize + o) % policy_names.len()].as_str()).collect();
            let pols: Vec<Policy> = specs.iter().map(|s| Policy::parse(s)).collect();
            let first = (g as usize) % seats.len();
            let r = play_traced(seats, *singles, &pols, first, game_seed, format, !bench, full, fair);
            if bench {
                String::new()
            } else {
                json_line(g, game_seed, name, first, &specs, &r, full, format, fair)
            }
        })
        .collect();
    let secs = t0.elapsed().as_secs_f64();
    if !bench {
        let out = flags.get("out").cloned().unwrap_or_else(|| "traces.jsonl".into());
        let mut f = std::io::BufWriter::new(std::fs::File::create(&out).unwrap());
        for l in &lines {
            f.write_all(l.as_bytes()).unwrap();
            f.write_all(b"\n").unwrap();
        }
    }
    println!("TRACE {games} games {:.1} games/s threads {}{}", games as f64 / secs, rayon::current_num_threads(), if bench { " (bench, no step lines)" } else { "" });
}
