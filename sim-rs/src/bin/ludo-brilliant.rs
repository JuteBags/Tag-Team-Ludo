//! Brilliant-move research (#100), native: tools/ai/brilliant.ts's study at native speed, on the molab box.
//!   ludo-brilliant --layout 2p --study extreme|first|normal|random --games 200 --from 1 --threads 16
//!                  --net extreme-net.json --playout playout-rules.json --hard hard-rules.json --out file.jsonl
//! Self-play games with the app's engine and parameters (sim-wasm: Extreme = choose_race with up to 128
//! playouts and a 12-turn cut, the trained net at the cut, the playout rules at every seat in the playouts; the
//! app's dice). Every game plays to the end (until one person is left). At every real decision of the side under
//! study: the best move at 16..256 playouts at two review seeds (review_cached: each rung extends the last, so
//! it is review(n) exactly), every candidate's gap and SE at 256 (seed A), the move played and the Hard bot's
//! pick (TS Hard = search depth 1 with Hard's rules; Normal = greedy with Hard's rules). One JSON line per
//! decision, the same fields as brilliant.ts. Games run in parallel (rayon, --threads, at most 16).
use ludo_sim::bot::Policy;
use ludo_sim::dice::roll_face;
use ludo_sim::eval::Evaluator;
use ludo_sim::game::{Game, PHASE_OVER, PHASE_ROLL};
use ludo_sim::rng::Rng;
use ludo_sim::rules::MoveList;
use ludo_sim::search::SearchOptions;
use ludo_sim::trace::modes;
use rayon::prelude::*;
use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;

const CUT: u32 = 12;
/// The rungs (#100): the owner's 8, 10, 24 and 30 added; review_cached extends the same playouts rung to rung, so they cost little.
const LADDER: [usize; 11] = [8, 10, 16, 24, 30, 32, 48, 64, 96, 128, 256];

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut f: HashMap<String, String> = HashMap::new();
    let mut i = 1;
    while i + 1 < args.len() {
        f.insert(args[i].trim_start_matches("--").to_string(), args[i + 1].clone());
        i += 2;
    }
    let get = |k: &str, d: &str| f.get(k).cloned().unwrap_or_else(|| d.to_string());
    let threads: usize = get("threads", "16").parse().unwrap();
    assert!(threads <= 16, "at most 16 threads on the box");
    rayon::ThreadPoolBuilder::new().num_threads(threads).build_global().unwrap();
    let layout = get("layout", "2p");
    let study = get("study", "extreme");
    let games: usize = get("games", "16").parse().unwrap();
    let from: i64 = get("from", "1").parse().unwrap();
    let out_path = get("out", "brilliant.jsonl");
    let net = Evaluator::from_json_text(&std::fs::read_to_string(get("net", "extreme-net.json")).unwrap());
    let playout = Arc::new(Evaluator::from_json_text(&std::fs::read_to_string(get("playout", "playout-rules.json")).unwrap()));
    let hard_path = get("hard", "hard-rules.json");
    // sim-wasm's base: Hard-style search over the playout rules (depth 1, chance 1, their_k 3).
    let base = Policy::Search { eval: playout, opts: SearchOptions { depth: 1, chance: 1, their_k: 3, race: false, cut: 0.0 }, temperature: 0.0 };
    // TS Hard: chooseExtreme(hard, depth 1) = net:<hard>:1 (chance 2, their_k 3); TS Normal: chooseGreedy(hard).
    let hard = Policy::parse(&format!("net:{hard_path}:1"));
    let normal = Policy::parse(&format!("greedy:{hard_path}"));
    let (_, seats, singles) = modes().into_iter().find(|m| m.0 == layout).unwrap_or_else(|| panic!("unknown layout {layout}"));

    let t0 = std::time::Instant::now();
    let results: Vec<(Vec<String>, bool)> = (0..games)
        .into_par_iter()
        .map(|gi| {
            let seed = from + gi as i64;
            let mut g = Game::new(&seats, singles);
            g.current = (seed as usize) % seats.len();
            let mut dice = Rng::seeded((((seed * 1_000_003) as u32) ^ 0x2545_f491) as i64);
            let mut ml = MoveList::new();
            let mut lines = Vec::new();
            let mut steps = 0u32;
            while g.phase != PHASE_OVER && steps < 40000 {
                steps += 1;
                if g.phase == PHASE_ROLL {
                    let face = roll_face(&g.b, g.current_color(), &mut dice, g.singles, &mut ml);
                    g.roll(face);
                    continue;
                }
                let owner = g.b.p[g.current].owner;
                let weak = study != "extreme" && owner == 0;
                let n = steps as i64;
                let mut rng = Rng::seeded(seed * 1_000_003 + n * 7919);
                let play = if weak {
                    match study.as_str() {
                        "first" => 0,
                        // The weak floor (#100): a uniformly random legal move.
                        "random" => ((rng.next() * g.moves.n as f64) as usize).min(g.moves.n - 1),
                        _ => normal.choose(&g, &mut rng),
                    }
                } else {
                    ludo_sim::rollout::choose_race(&g, &mut rng, 128, CUT, Some(&net), &base, &base)
                };
                let logged = study == "extreme" || owner == 0;
                if logged && g.moves.n > 1 {
                    let sa = (seed * 7919 + n) as u32 as i64;
                    let sb = (sa as u32 ^ 0x9e37_79b9) as i64;
                    let ladder = |sd: i64| -> (Vec<usize>, ludo_sim::rollout::Review) {
                        let mut res = Vec::new();
                        let mut last = None;
                        let bests = LADDER
                            .iter()
                            .map(|&k| {
                                let r = ludo_sim::rollout::review_cached(&g, sd, k, CUT, Some(&net), &base, &mut res);
                                let b = r.of_move.iter().position(|&c| c == r.best).unwrap_or(0);
                                last = Some(r);
                                b
                            })
                            .collect();
                        (bests, last.unwrap())
                    };
                    let (la, ref256) = ladder(sa);
                    let distinct = {
                        let mut v = ref256.of_move.clone();
                        v.sort_unstable();
                        v.dedup();
                        v.len()
                    };
                    if distinct > 1 {
                        let (lb, _) = ladder(sb);
                        let mut hr = Rng::seeded(seed * 1_000_003 + n * 7919 + 1);
                        let hard_pick = hard.choose(&g, &mut hr);
                        let best = ref256.of_move.iter().position(|&c| c == ref256.best).unwrap_or(0);
                        let fmt = |v: &[f64], s: f64, d: usize| v.iter().map(|x| format!("{:.*}", d, x * s)).collect::<Vec<_>>().join(",");
                        let of = ref256.of_move.iter().map(|c| c.to_string()).collect::<Vec<_>>().join(",");
                        let li = |v: &[usize]| v.iter().map(|c| c.to_string()).collect::<Vec<_>>().join(",");
                        lines.push(format!(
                            "{{\"layout\":\"{layout}\",\"study\":\"{study}\",\"seed\":{seed},\"n\":{n},\"owner\":{owner},\"color\":{},\"moves\":{},\"of\":[{of}],\"gap\":[{}],\"se\":[{}],\"mean\":[{}],\"best\":{best},\"played\":{play},\"hard\":{hard_pick},\"ladder\":{{\"a\":[{}],\"b\":[{}]}},\"at\":[{}],\"engine\":\"native\"}}",
                            g.current_color(),
                            g.moves.n,
                            fmt(&ref256.gap, 100.0, 2),
                            fmt(&ref256.se, 100.0, 2),
                            fmt(&ref256.mean, 1.0, 4),
                            li(&la),
                            li(&lb),
                            LADDER.iter().map(|k| k.to_string()).collect::<Vec<_>>().join(",")
                        ));
                    }
                }
                let m = g.moves.m[play];
                g.play(&m);
            }
            (lines, g.phase == PHASE_OVER)
        })
        .collect();
    let unfinished = results.iter().filter(|r| !r.1).count();
    let mut out = std::fs::File::create(&out_path).unwrap();
    let mut n = 0;
    for (lines, _) in &results {
        for l in lines {
            writeln!(out, "{l}").unwrap();
            n += 1;
        }
    }
    println!("BRILLNATIVE {layout} {study} games {games} from {from}: {n} decisions, {unfinished} unfinished, {:.1} s", t0.elapsed().as_secs_f64());
}
