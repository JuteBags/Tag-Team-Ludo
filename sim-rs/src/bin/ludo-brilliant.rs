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
use ludo_sim::rules::{apply_move, is_safe, legal_moves, square_of, Board, MoveList, KIND_SINGLE, LAST_TRACK};
use ludo_sim::search::SearchOptions;
use ludo_sim::trace::modes;
use rayon::prelude::*;
use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;

const CUT: u32 = 12;

/// reviewWhy.ts dangerAt (#97), native: the chance (a lower bound, fair dice) that `color`'s token at `progress` is
/// captured before `color` moves again: per opposing side, the trays (k sixes then a non-6; three 6s cancel) holding a
/// die that captures it right away; sides independent. Nothing on a star, in the home column or in base is in danger.
fn danger_at(b: &Board, color: u8, progress: i8, singles: bool) -> f64 {
    let sq = square_of(color, progress);
    if sq < 0 || is_safe(sq) {
        return 0.0;
    }
    let me = b.of(color);
    let mut safe = 1.0;
    let mut ml = MoveList::new();
    for opp in b.players() {
        if opp.owner == me.owner {
            continue;
        }
        let mut hits = [false; 7];
        for d in 1..=6u8 {
            ml.clear();
            legal_moves(b, opp.color, d, singles, &mut ml);
            hits[d as usize] = ml.as_slice().iter().any(|m| m.captures().iter().any(|&(c, t)| c == color && me.tokens[t as usize] == progress));
        }
        let mut p = 0.0;
        for k in 0..=2i32 {
            for f in 1..=5usize {
                if (k > 0 && hits[6]) || hits[f] {
                    p += (1.0f64 / 6.0).powi(k + 1);
                }
            }
        }
        safe *= 1.0 - p;
    }
    1.0 - safe
}

/// The counter-intuitive facts of each legal move (#100, idea 3), from the rules only: [captures, the moved token's
/// danger after it, it moves the back token while a more advanced token could move, it breaks a pair].
fn move_facts(g: &Game) -> String {
    let b = &g.b;
    let ms = &g.moves.m[..g.moves.n];
    let color = g.current_color();
    let toks = b.of(color).tokens;
    let on_track = |t: i8| (0..=LAST_TRACK).contains(&t);
    let back = toks.iter().copied().filter(|&t| on_track(t)).min();
    ms.iter()
        .map(|m| {
            let after = apply_move(b, m);
            let danger = if on_track(m.to) { danger_at(&after, color, m.to, g.singles) } else { 0.0 };
            let is_back = on_track(m.from) && Some(m.from) == back && ms.iter().any(|o| on_track(o.from) && o.from > m.from);
            let sq = square_of(color, m.from);
            let breaks = !g.singles && m.kind == KIND_SINGLE && sq >= 0 && !is_safe(sq) && b.count_at(color, sq) >= 2;
            format!("[{},{:.3},{},{}]", (m.ncap > 0) as u8, danger, is_back as u8, breaks as u8)
        })
        .collect::<Vec<_>>()
        .join(",")
}
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
    // --facts 1: replay the same games (same seeds, same choices) without the review ladder, logging each logged
    // decision's per-move facts (move_facts) to join with the ladder data by (seed, n).
    let facts_only = get("facts", "0") == "1";
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
                if logged && g.moves.n > 1 && facts_only {
                    lines.push(format!("{{\"layout\":\"{layout}\",\"study\":\"{study}\",\"seed\":{seed},\"n\":{n},\"moves\":{},\"played\":{play},\"f\":[{}]}}", g.moves.n, move_facts(&g)));
                } else if logged && g.moves.n > 1 {
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
