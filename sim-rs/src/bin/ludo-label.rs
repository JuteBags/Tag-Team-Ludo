//! TD(lambda) targets for a self-play shard, along each game's REAL trajectory (TDLeaf-style):
//!   ludo-label --shard gen.bin --net net.json --lambda 0.7 --out gen.bin.targets [--depth 0] [--threads N]
//!   ludo-label --shard gen.bin --eval blend:<net.json>:<rules.json>:<alpha> ...   (value with a blend, blend.ts)
//!
//! Every game of the shard is replayed from its seed (the engine is deterministic: the same picks, first
//! colour, dice and policies as ludo-selfplay / selfplay.ts), and every replayed kept position is checked
//! byte for byte against the shard's inputs and meta, so the targets line up with the rows or the run
//! fails. At each position before a roll (all of them, kept or not) v_t = each person's chance of
//! finishing first among the people still playing, from --net (depth 0: the evaluator itself, nothing
//! about the dice; depth >= 1: a search from there, which averages its own extra rolls at 1/6). Then
//!   G_t = (1 - lambda) v_{t+1} + lambda G_{t+1},   G at the last position = z,
//! z = one-hot of the person who finishes next among those still playing (the real result). Whenever the
//! set of people still playing changes between t and t+1 (someone got home), the chain restarts at
//! G_t = z_t, so a target never mixes chances over different sets of people.
//! Output: u32 header length, JSON header, then float32 [positions, 4]: the target per person (owner
//! index; 0 for people not in the game or already home), rows in shard order.
use ludo_sim::bot::Policy;
use ludo_sim::encode::{encode, D};
use ludo_sim::eval::Evaluator;
use ludo_sim::game::{Game, PHASE_OVER, PHASE_ROLL};
use ludo_sim::rng::{Rng, Streams};
use ludo_sim::rules::{is_done, MoveList};
use ludo_sim::search::{state_values, SearchOptions};
use ludo_sim::trace::modes;
use rayon::prelude::*;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Write;

fn live_mask(g: &Game) -> u8 {
    let mut m = 0u8;
    for p in g.b.players() {
        if !is_done(p) {
            m |= 1 << p.owner;
        }
    }
    m
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
    let shard_path = flags.get("shard").expect("--shard").clone();
    // --net <weights.json>, or --eval blend:<net>:<rules>:<alpha> (the evaluator a residual net plays as)
    let net_path = flags.get("eval").or_else(|| flags.get("net")).expect("--net or --eval").clone();
    let lambda: f64 = flags.get("lambda").map(|s| s.parse().unwrap()).unwrap_or(0.7);
    let depth: u32 = flags.get("depth").map(|s| s.parse().unwrap()).unwrap_or(0);
    let out_path = flags.get("out").cloned().unwrap_or_else(|| format!("{shard_path}.targets"));
    let read = |p: &str| Evaluator::from_json_text(&std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{p}: {e}")));
    let eval = if let Some(spec) = net_path.strip_prefix("blend:") {
        let parts: Vec<&str> = spec.split(':').collect();
        assert_eq!(parts.len(), 3, "--eval blend:<net>:<rules>:<alpha>");
        Evaluator::Blend(std::sync::Arc::new(read(parts[0])), std::sync::Arc::new(read(parts[1])), parts[2].parse().unwrap())
    } else {
        read(&net_path)
    };

    let buf = std::fs::read(&shard_path).unwrap();
    let hl = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
    let head: Value = serde_json::from_slice(&buf[4..4 + hl]).unwrap();
    assert_eq!(head["D"].as_u64().unwrap() as usize, D, "shard D differs from this engine");
    let format = head.get("v").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
    let keep = head["keep"].as_f64().unwrap();
    // shards from --dice fair replay with fair dice
    let fair = head.get("dice").and_then(|d| d.as_str()) == Some("fair");
    let games = head["games"].as_array().unwrap();
    let rest = buf.len() - 4 - hl;
    let rows = rest / (4 * D * 4 + 16);
    assert_eq!(rows * (4 * D * 4 + 16), rest, "shard size is not header + rows");
    let x_off = 4 + hl;
    let m_off = x_off + rows * 4 * D * 4;
    let meta = |r: usize, k: usize| i32::from_le_bytes(buf[m_off + (r * 4 + k) * 4..m_off + (r * 4 + k) * 4 + 4].try_into().unwrap());
    // rows of each game, in shard order
    let mut first_row = vec![usize::MAX; games.len()];
    let mut count = vec![0usize; games.len()];
    for r in 0..rows {
        let g = meta(r, 0) as usize;
        if first_row[g] == usize::MAX {
            first_row[g] = r;
        }
        count[g] += 1;
    }
    let all = modes();

    let per_game: Vec<Vec<[f32; 4]>> = (0..games.len())
        .into_par_iter()
        .map(|gi| {
            let gh = &games[gi];
            let game_seed = gh["seed"].as_i64().unwrap();
            let mode = gh["mode"].as_str().unwrap();
            let specs: Vec<String> = gh["policies"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect();
            let (_, seats, singles) = all.iter().find(|m| m.0 == mode).unwrap();
            let pols: Vec<Policy> = specs.iter().map(|s| Policy::parse(s)).collect();
            // selfplay: one pool pick per person, then the first colour, from the game's rng
            let mut rng = Rng::seeded(game_seed);
            for _ in 0..specs.len() {
                rng.next();
            }
            let mut g = Game::new(seats, *singles);
            g.current = ((rng.next() * 4.0).floor() as usize) % seats.len();
            let mut st = Streams::new(rng, game_seed, format);
            st.fair = fair;
            let mut keep_rng = Rng::seeded(((game_seed as u32) ^ 0x5bd1_e995) as i64);
            let mut ml = MoveList::new();
            let mut x = [0.0f64; 4 * D];
            // every position before a roll: its values, its live set, and its shard row if kept
            let mut vals: Vec<[f64; 4]> = Vec::new();
            let mut live: Vec<u8> = Vec::new();
            let mut kept: Vec<usize> = Vec::new();
            let mut turn = 0i32;
            let mut steps = 0;
            let mut nkept = 0usize;
            while g.phase != PHASE_OVER && steps < 50000 {
                if g.phase == PHASE_ROLL {
                    if keep_rng.next() < keep {
                        let r = first_row[gi] + nkept;
                        assert!(nkept < count[gi] && meta(r, 0) as usize == gi && meta(r, 1) == turn, "game {gi}: replay diverges from the shard (row {r})");
                        encode(&g.b, g.current, g.singles, g.tray(), g.sixes, &mut x);
                        for k in 0..g.b.n * D {
                            let o = x_off + (r * 4 * D + k) * 4;
                            assert!(f32::from_le_bytes(buf[o..o + 4].try_into().unwrap()).to_bits() == (x[k] as f32).to_bits(), "game {gi}: inputs differ at row {r}");
                        }
                        kept.push(vals.len());
                        nkept += 1;
                    }
                    turn += 1;
                    let mut v = [0.0f64; 4];
                    if depth == 0 {
                        eval.owner_chances(&g, &mut v);
                    } else {
                        v = state_values(&eval, &g, SearchOptions { depth, chance: 2, their_k: 3, race: false, cut: 0.0 });
                    }
                    vals.push(v);
                    live.push(live_mask(&g));
                    let f = st.roll_face(&g.b, g.current_color(), g.singles, &mut ml);
                    g.roll(f);
                } else {
                    let k = pols[g.b.p[g.current].owner as usize].choose(&g, &mut st.rng);
                    let m = g.moves.m[k];
                    g.play(&m);
                }
                steps += 1;
            }
            assert_eq!(nkept, count[gi], "game {gi}: kept rows differ");
            // z_t: the person who finishes next among those live at t (ownerRanking order)
            let order = g.owner_ranking();
            let z_of = |mask: u8| -> [f64; 4] {
                let mut z = [0.0f64; 4];
                if let Some(&o) = order.iter().find(|&&o| mask & (1 << o) != 0) {
                    z[o as usize] = 1.0;
                }
                z
            };
            let n = vals.len();
            let mut target = vec![[0.0f64; 4]; n];
            for t in (0..n).rev() {
                let z = z_of(live[t]);
                target[t] = if t + 1 == n || live[t + 1] != live[t] {
                    z
                } else {
                    let mut gt = [0.0f64; 4];
                    for o in 0..4 {
                        gt[o] = (1.0 - lambda) * vals[t + 1][o] + lambda * target[t + 1][o];
                    }
                    gt
                };
            }
            kept.iter().map(|&t| [target[t][0] as f32, target[t][1] as f32, target[t][2] as f32, target[t][3] as f32]).collect()
        })
        .collect();

    // back to shard row order
    let mut out = vec![[0.0f32; 4]; rows];
    for (gi, ts) in per_game.iter().enumerate() {
        for (j, t) in ts.iter().enumerate() {
            out[first_row[gi] + j] = *t;
        }
    }
    let header = format!("{{\"v\":1,\"kind\":\"lambda\",\"lambda\":{lambda},\"depth\":{depth},\"net\":\"{}\",\"shard\":\"{}\",\"positions\":{rows}}}", net_path.replace('\\', "/"), shard_path.replace('\\', "/"));
    let mut f = std::io::BufWriter::new(std::fs::File::create(&out_path).unwrap());
    f.write_all(&(header.len() as u32).to_le_bytes()).unwrap();
    f.write_all(header.as_bytes()).unwrap();
    for t in &out {
        for v in t {
            f.write_all(&v.to_le_bytes()).unwrap();
        }
    }
    f.flush().unwrap();
    println!("LABEL {} games {rows} positions lambda {lambda} depth {depth} -> {out_path}", games.len());
}
