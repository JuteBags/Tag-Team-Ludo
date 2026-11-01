//! tools/ai/selfplay.ts in Rust: the same games, the same kept positions, the same v1 shard bytes.
//!   ludo-selfplay --games 2000 --seed 7 --out shard.bin --pool hard:65,normal:22,easy:10,random:3
//!                 [--modes 2p,3p,...] [--keep 0.1] [--commit <sha>] [--threads N] [--format 2]
//!                 [--lockstep W [--gpu]] [--dice fair]
//! --lockstep W: W games in flight, stepped together in two halves. Each round one half's search leaves
//! are valued in one batch (search::collect_leaves, then eval::batch_values) while the other half
//! chooses from its values and plays on to its next decision. Same bytes as without it.
//! --gpu (build with --features cuda): that batch is valued on the GPU (gpu.rs), still the same bytes.
//! One invocation writes one shard (like one selfplay.mjs worker); its games run in parallel and are
//! concatenated in game order, so the file is byte-identical to selfplay.mjs with the same flags.
use ludo_sim::bot::Policy;
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

/// One game being played: everything the plain loop keeps in locals.
struct Live {
    g: usize,
    game_seed: i64,
    mode: String,
    specs: Vec<String>,
    pols: Vec<Policy>,
    keep_rng: Rng,
    gm: Game,
    st: Streams,
    ml: MoveList,
    buf: Vec<f64>,
    x: Vec<f32>,
    meta: Vec<i32>,
    turn: i32,
    steps: usize,
}

impl Live {
    /// Plays rolls and non-search moves until a search policy must choose among several moves (true)
    /// or the game is over (false).
    fn advance(&mut self, keep: f64) -> bool {
        while self.gm.phase != PHASE_OVER && self.steps < 50000 {
            if self.gm.phase == PHASE_ROLL {
                if self.keep_rng.next() < keep {
                    let gm = &self.gm;
                    let buf: &mut [f64; 4 * D] = (&mut self.buf[..]).try_into().unwrap();
                    encode(&gm.b, gm.current, gm.singles, gm.tray(), gm.sixes, buf);
                    let n = gm.b.n;
                    self.x.extend(self.buf[..n * D].iter().map(|&v| v as f32));
                    self.x.extend(std::iter::repeat(0.0f32).take((4 - n) * D));
                    self.meta.extend_from_slice(&[self.g as i32, self.turn, n as i32, gm.current as i32]);
                }
                self.turn += 1;
                let f = self.st.roll_face(&self.gm.b, self.gm.current_color(), self.gm.singles, &mut self.ml);
                self.gm.roll(f);
            } else {
                let o = self.gm.b.p[self.gm.current].owner as usize;
                if matches!(self.pols[o], Policy::Search { .. }) && self.gm.moves.len() > 1 {
                    return true;
                }
                let k = self.pols[o].choose(&self.gm, &mut self.st.rng);
                let m = self.gm.moves.m[k];
                self.gm.play(&m);
            }
            self.steps += 1;
        }
        false
    }

    fn search(&self) -> (std::sync::Arc<ludo_sim::eval::Evaluator>, ludo_sim::search::SearchOptions, f64) {
        match &self.pols[self.gm.b.p[self.gm.current].owner as usize] {
            Policy::Search { eval, opts, temperature } => (eval.clone(), *opts, *temperature),
            _ => unreachable!(),
        }
    }
}

/// The game's entry in the shard header.
fn header(game_seed: i64, mode: &str, specs: &[String], gm: &Game, turn: i32) -> String {
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
    h
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
    // --dice fair: every face 1 in 6 (the engine's training dice); default: the app's dice
    let fair = flags.get("dice").map(|d| d == "fair").unwrap_or(false);
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

    let start = |g: usize| -> Live {
        let game_seed = seed * 1_000_003 + g as i64;
        let mut rng = Rng::seeded(game_seed);
        let (mode, seats, singles) = &mode_list[g % mode_list.len()];
        let people = seats.iter().map(|s| s.1).max().unwrap() as usize + 1;
        let specs: Vec<String> = (0..people).map(|_| pick(rng.next()).to_string()).collect();
        let pols: Vec<Policy> = specs.iter().map(|s| Policy::parse(s)).collect();
        let keep_rng = Rng::seeded(((game_seed as u32) ^ 0x5bd1_e995) as i64);
        let mut gm = Game::new(seats, *singles);
        gm.current = ((rng.next() * 4.0).floor() as usize) % seats.len();
        let mut st = Streams::new(rng, game_seed, format);
        st.fair = fair;
        Live { g, game_seed, mode: mode.to_string(), specs, pols, keep_rng, gm, st, ml: MoveList::new(), buf: vec![0.0; 4 * D], x: Vec::new(), meta: Vec::new(), turn: 0, steps: 0 }
    };
    let lockstep: usize = flags.get("lockstep").map(|s| s.parse().unwrap()).unwrap_or(0);
    if flags.contains_key("gpu") {
        assert!(lockstep > 0, "--gpu needs --lockstep W");
        #[cfg(feature = "cuda")]
        ludo_sim::eval::use_gpu(true);
        #[cfg(not(feature = "cuda"))]
        panic!("--gpu: build with --features cuda");
    }

    let t0 = Instant::now();
    let outs: Vec<GameOut> = if lockstep > 0 {
        use ludo_sim::eval::{batch_values, Evaluator};
        use std::sync::Arc;
        type Ready = (Vec<Vec<Game>>, Vec<Vec<[f64; 4]>>);
        let mut outs: Vec<Option<GameOut>> = (0..games).map(|_| None).collect();
        let mut next = 0usize;
        let (mut rounds, mut nleaves) = (0usize, 0usize);
        let mut tt = [0.0f64; 4]; // seconds in: advance, collect, waiting for values, choose
        // One half of the games: choose with the values of its last leaves, refill, play on to the next
        // search decision (finished games leave), collect the next leaves.
        let half = lockstep.div_ceil(2).max(1);
        let prepare = |grp: &mut Vec<Live>, rd: Option<Ready>, next: &mut usize, outs: &mut Vec<Option<GameOut>>, tt: &mut [f64; 4]| -> (Vec<Vec<Game>>, Vec<Arc<Evaluator>>) {
            if let Some((ls_all, vs_all)) = rd {
                let t = Instant::now();
                grp.par_iter_mut().zip(ls_all.into_par_iter().zip(vs_all.into_par_iter())).for_each(|(l, (ls, vs))| {
                    let mut map = ludo_sim::search::Map::default();
                    for (s, v) in ls.iter().zip(vs) {
                        map.insert(ludo_sim::search::leaf_key(s), v);
                    }
                    let (eval, opts, temperature) = l.search();
                    let k = ludo_sim::search::choose_extreme_with(&eval, &l.gm, &mut l.st.rng, opts, temperature, map);
                    let m = l.gm.moves.m[k];
                    l.gm.play(&m);
                    l.steps += 1;
                });
                tt[3] += t.elapsed().as_secs_f64();
            }
            while grp.len() < half && *next < games {
                grp.push(start(*next));
                *next += 1;
            }
            let t = Instant::now();
            let need: Vec<bool> = grp.par_iter_mut().map(|l| l.advance(keep)).collect();
            tt[0] += t.elapsed().as_secs_f64();
            let mut still = Vec::with_capacity(grp.len());
            for (l, n) in grp.drain(..).zip(need) {
                if n {
                    still.push(l);
                } else {
                    let h = header(l.game_seed, &l.mode, &l.specs, &l.gm, l.turn);
                    outs[l.g] = Some(GameOut { x: l.x, meta: l.meta, header: h });
                }
            }
            *grp = still;
            let t = Instant::now();
            let leaves: Vec<Vec<Game>> = grp
                .par_iter()
                .map(|l| {
                    let (eval, opts, _) = l.search();
                    ludo_sim::search::collect_leaves(&eval, &l.gm, opts)
                })
                .collect();
            let arcs: Vec<Arc<Evaluator>> = grp.iter().map(|l| l.search().0).collect();
            tt[1] += t.elapsed().as_secs_f64();
            (leaves, arcs)
        };
        // Two halves in flight: while one half's leaves are valued (on the GPU, or on the CPU pool), the
        // other half chooses and collects. Each game's own sequence is unchanged, so are the bytes.
        let mut groups: [Vec<Live>; 2] = [Vec::new(), Vec::new()];
        let mut ready: [Option<Ready>; 2] = [None, None];
        let (mut la, mut ea) = prepare(&mut groups[0], None, &mut next, &mut outs, &mut tt);
        let mut cur = 0usize;
        loop {
            let other = 1 - cur;
            if groups[0].is_empty() && groups[1].is_empty() && next >= games {
                break;
            }
            let rd = ready[other].take();
            let (vals, (lb, eb)) = std::thread::scope(|s| {
                let (la, ea) = (&la, &ea);
                let h = s.spawn(move || {
                    let ev: Vec<&Evaluator> = ea.iter().map(|a| &**a).collect();
                    batch_values(&ev, la)
                });
                let r = prepare(&mut groups[other], rd, &mut next, &mut outs, &mut tt);
                let tw = Instant::now();
                let v = h.join().unwrap();
                tt[2] += tw.elapsed().as_secs_f64();
                (v, r)
            });
            rounds += 1;
            nleaves += vals.iter().map(|v| v.len()).sum::<usize>();
            ready[cur] = Some((la, vals));
            la = lb;
            ea = eb;
            cur = other;
        }
        eprintln!(
            "LOCKSTEP rounds {rounds} leaves {nleaves} ({:.1} per round) secs advance {:.2} collect {:.2} wait-values {:.2} choose {:.2}",
            nleaves as f64 / rounds.max(1) as f64,
            tt[0],
            tt[1],
            tt[2],
            tt[3]
        );
        outs.into_iter().map(|o| o.unwrap()).collect()
    } else {
        (0..games)
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
            st.fair = fair;
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
                    let f = st.roll_face(&gm.b, gm.current_color(), gm.singles, &mut ml);
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
        .collect()
    };
    let secs = t0.elapsed().as_secs_f64();

    let positions: usize = outs.iter().map(|o| o.meta.len() / 4).sum();
    let v = if format >= 2 { format!("\"v\":{format},") } else { String::new() };
    let dice = if fair { "\"dice\":\"fair\"," } else { "" };
    let mut head = format!("{{{v}\"D\":{D},\"commit\":\"{commit}\",\"seed\":{seed},\"keep\":{keep},{dice}\"games\":[");
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
    let probes = ludo_sim::search::PROBES.load(std::sync::atomic::Ordering::Relaxed);
    let cuts = ludo_sim::search::CUTS.load(std::sync::atomic::Ordering::Relaxed);
    println!("DONE {games} games {positions} positions {:.1} games/s capped {capped} sampled {sampled} offBest {off_best} probes {probes} cuts {cuts}", games as f64 / secs);
}
