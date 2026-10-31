//! tools/ai/selfplay.ts in Rust: the same games, the same kept positions, the same v1 shard bytes.
//!   ludo-selfplay --games 2000 --seed 7 --out shard.bin --pool hard:65,normal:22,easy:10,random:3
//!                 [--modes 2p,3p,...] [--keep 0.1] [--commit <sha>] [--threads N] [--format 2]
//! One invocation writes one shard (like one selfplay.mjs worker); its games run in parallel and are
//! concatenated in game order, so the file is byte-identical to selfplay.mjs with the same flags.
use ludo_sim::bot::Policy;
use ludo_sim::dice::roll_face;
use ludo_sim::encode::{encode, D};
use ludo_sim::game::{Game, PHASE_OVER, PHASE_ROLL};
use ludo_sim::rng::{Rng, Streams};
use ludo_sim::rules::{MoveList, BASE, FINISHED};
use ludo_sim::trace::modes;
use rayon::prelude::*;
use std::collections::HashMap;
use std::fmt::Write as _;
use std::io::Write;
use std::time::Instant;

struct GameOut {
    x: Vec<f32>,
    meta: Vec<i32>,
    header: String,
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
    let games: usize = flags.get("games").map(|s| s.parse().unwrap()).unwrap_or(1000);
    let seed: i64 = flags.get("seed").map(|s| s.parse().unwrap()).unwrap_or(1);
    let keep_s = flags.get("keep").cloned().unwrap_or_else(|| "0.1".into());
    let keep: f64 = keep_s.parse().unwrap();
    let commit = flags.get("commit").cloned().unwrap_or_default();
    let format: u32 = flags.get("format").map(|s| s.parse().unwrap()).unwrap_or(ludo_sim::rng::FORMAT);
    let all = modes();
    let mode_list: Vec<_> = match flags.get("modes") {
        Some(m) if !m.is_empty() => m.split(',').map(|n| all.iter().find(|x| x.0 == n).unwrap_or_else(|| panic!("unknown mode {n}")).clone()).collect(),
        _ => all.clone(),
    };
    let pool: Vec<(String, f64)> = flags
        .get("pool")
        .filter(|s| !s.is_empty())
        .map(|s| s.as_str())
        .unwrap_or("hard:1")
        .split(',')
        .map(|x| {
            let k = x.rfind(':').unwrap();
            (x[..k].to_string(), x[k + 1..].parse::<f64>().unwrap())
        })
        .collect();
    let total: f64 = pool.iter().fold(0.0, |s, p| s + p.1);
    let pick = |mut r: f64| -> &str {
        for (spec, w) in &pool {
            r -= w / total;
            if r < 0.0 {
                return spec;
            }
        }
        &pool[pool.len() - 1].0
    };
    if let Some(t) = flags.get("threads") {
        rayon::ThreadPoolBuilder::new().num_threads(t.parse().unwrap()).build_global().unwrap();
    }

    let t0 = Instant::now();
    let outs: Vec<GameOut> = (0..games)
        .into_par_iter()
        .map(|g| {
            let game_seed = seed * 1_000_003 + g as i64;
            let mut rng = Rng::seeded(game_seed);
            let (mode, seats, singles) = &mode_list[g % mode_list.len()];
            let people = seats.iter().map(|s| s.1).max().unwrap() as usize + 1;
            let specs: Vec<&str> = (0..people).map(|_| pick(rng.next())).collect();
            let pols: Vec<Policy> = specs.iter().map(|s| Policy::parse(s)).collect();
            let mut keep_rng = Rng::seeded(((game_seed as u32) ^ 0x5bd1_e995) as i64);
            let mut gm = Game::new(seats, *singles);
            gm.current = ((rng.next() * 4.0).floor() as usize) % seats.len();
            let mut st = Streams::new(rng, game_seed, format);
            let mut ml = MoveList::new();
            let mut buf = [0.0f64; 4 * D];
            let (mut x, mut meta) = (Vec::new(), Vec::new());
            let mut turn = 0i32;
            let mut steps = 0;
            while gm.phase != PHASE_OVER && steps < 50000 {
                if gm.phase == PHASE_ROLL {
                    if keep_rng.next() < keep {
                        encode(&gm.b, gm.current, gm.singles, gm.tray(), gm.sixes, &mut buf);
                        let n = gm.b.n;
                        x.extend(buf[..n * D].iter().map(|&v| v as f32));
                        x.extend(std::iter::repeat(0.0f32).take((4 - n) * D));
                        meta.extend_from_slice(&[g as i32, turn, n as i32, gm.current as i32]);
                    }
                    turn += 1;
                    let f = roll_face(&gm.b, gm.current_color(), st.dice(), gm.singles, &mut ml);
                    gm.roll(f);
                } else {
                    let o = gm.b.p[gm.current].owner as usize;
                    let k = pols[o].choose(&gm, &mut st.rng);
                    let m = gm.moves.m[k];
                    gm.play(&m);
                }
                steps += 1;
            }
            let order = gm.owner_ranking();
            let mut left = vec![0i32; order.len()];
            for p in gm.b.players() {
                left[p.owner as usize] += p.tokens.iter().map(|&t| FINISHED as i32 - t.max(BASE) as i32).sum::<i32>();
            }
            let mut h = String::new();
            let list = |v: &mut String, xs: &[String]| {
                v.push('[');
                v.push_str(&xs.join(","));
                v.push(']');
            };
            write!(h, "{{\"seed\":{game_seed},\"mode\":\"{mode}\",\"owners\":").unwrap();
            list(&mut h, &gm.b.players().iter().map(|p| p.owner.to_string()).collect::<Vec<_>>());
            h.push_str(",\"order\":");
            list(&mut h, &order.iter().map(|o| o.to_string()).collect::<Vec<_>>());
            h.push_str(",\"policies\":");
            list(&mut h, &specs.iter().map(|s| format!("\"{s}\"")).collect::<Vec<_>>());
            write!(h, ",\"over\":{},\"turns\":{turn},\"left\":", gm.phase == PHASE_OVER).unwrap();
            list(&mut h, &left.iter().map(|o| o.to_string()).collect::<Vec<_>>());
            h.push('}');
            GameOut { x, meta, header: h }
        })
        .collect();
    let secs = t0.elapsed().as_secs_f64();

    let positions: usize = outs.iter().map(|o| o.meta.len() / 4).sum();
    let v = if format >= 2 { format!("\"v\":{format},") } else { String::new() };
    let mut head = format!("{{{v}\"D\":{D},\"commit\":\"{commit}\",\"seed\":{seed},\"keep\":{keep},\"games\":[");
    for (i, o) in outs.iter().enumerate() {
        if i > 0 {
            head.push(',');
        }
        head.push_str(&o.header);
    }
    head.push_str("]}");
    let out = flags.get("out").cloned().unwrap_or_else(|| "shard.bin".into());
    let mut f = std::io::BufWriter::new(std::fs::File::create(&out).unwrap());
    f.write_all(&(head.len() as u32).to_le_bytes()).unwrap();
    f.write_all(head.as_bytes()).unwrap();
    for o in &outs {
        for v in &o.x {
            f.write_all(&v.to_le_bytes()).unwrap();
        }
    }
    for o in &outs {
        for v in &o.meta {
            f.write_all(&v.to_le_bytes()).unwrap();
        }
    }
    f.flush().unwrap();
    let capped = outs.iter().filter(|o| o.header.contains("\"over\":false")).count();
    let sampled = ludo_sim::search::SAMPLED.load(std::sync::atomic::Ordering::Relaxed);
    let off_best = ludo_sim::search::OFF_BEST.load(std::sync::atomic::Ordering::Relaxed);
    println!("DONE {games} games {positions} positions {:.1} games/s capped {capped} sampled {sampled} offBest {off_best}", games as f64 / secs);
}
