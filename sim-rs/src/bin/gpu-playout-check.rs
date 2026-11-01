//! GPU playouts (gpu_playout.rs) vs rollout.rs playout() on the CPU: the same value for every playout
//! (bit for bit) and the same rng states afterwards, then the throughput of both.
//!   gpu-playout-check --base net:hard2-tuned.json:1:3:0:0:1 [--leaf lambda-gen3.json] [--cut 12]
//!                     [--starts 4000] [--reps 4] [--seed 1] [--threads 16] [--mode 4p]
//! Start positions: every position before a roll or a move in games played by --base (fair dice); each is
//! played out --reps times with different streams (seeded like rollout.rs evaluate), the mover's person
//! as `me`. Leaf positions from the GPU are valued on the CPU with --leaf, as playout() values them.
use ludo_sim::bot::Policy;
use ludo_sim::dice::{sample_face, FAIR};
use ludo_sim::eval::Evaluator;
use ludo_sim::game::{Game, PHASE_OVER, PHASE_ROLL};
use ludo_sim::gpu_playout::{playouts, LinearBase, Out};
use ludo_sim::rng::Rng;
use ludo_sim::rollout::playout;
use ludo_sim::trace::modes;
use rayon::prelude::*;
use std::collections::HashMap;
use std::time::Instant;

fn streams_for(s: i64) -> [u32; 5] {
    [s as u32, (s ^ 0x1111) as u32, (s ^ 0x2222) as u32, (s ^ 0x3333) as u32, (s ^ 0x1234_5678) as u32]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut flags: HashMap<String, String> = HashMap::new();
    let mut i = 1;
    while i + 1 < args.len() {
        flags.insert(args[i].trim_start_matches("--").to_string(), args[i + 1].clone());
        i += 2;
    }
    if let Some(t) = flags.get("threads") {
        rayon::ThreadPoolBuilder::new().num_threads(t.parse().unwrap()).build_global().unwrap();
    }
    let base_spec = flags.get("base").expect("--base net:<linear.json>:1:3:0:0:<chance>").clone();
    let base = Policy::parse(&base_spec);
    let lb = LinearBase::from_policy(&base).expect("--base must be a depth-1 readable-rules search");
    let leaf: Option<Evaluator> = flags.get("leaf").map(|p| Evaluator::from_json_text(&std::fs::read_to_string(p).unwrap()));
    let cut: u32 = flags.get("cut").map(|s| s.parse().unwrap()).unwrap_or(12);
    let nstarts: usize = flags.get("starts").map(|s| s.parse().unwrap()).unwrap_or(4000);
    let reps: usize = flags.get("reps").map(|s| s.parse().unwrap()).unwrap_or(4);
    let seed: i64 = flags.get("seed").map(|s| s.parse().unwrap()).unwrap_or(1);
    let mode_name = flags.get("mode").cloned().unwrap_or_else(|| "4p".into());
    let (_, seats, singles) = modes().into_iter().find(|m| m.0 == mode_name).expect("unknown mode");

    // start positions from games played by the base
    let t0 = Instant::now();
    let mut starts: Vec<Game> = Vec::new();
    let mut gi = 0i64;
    while starts.len() < nstarts {
        let mut g = Game::new(&seats, singles);
        g.current = (gi as usize) % seats.len();
        let mut dice = Rng::seeded(seed * 1_000_003 + gi);
        let mut rng = Rng::seeded(seed * 7_000_001 + gi);
        let mut steps = 0;
        while g.phase != PHASE_OVER && steps < 5000 && starts.len() < nstarts {
            starts.push(g);
            if g.phase == PHASE_ROLL {
                g.roll(sample_face(&FAIR, &mut dice));
            } else {
                let k = base.choose(&g, &mut rng);
                let m = g.moves.m[k];
                g.play(&m);
            }
            steps += 1;
        }
        gi += 1;
    }
    let jobs: Vec<(usize, i64)> = (0..starts.len()).flat_map(|s| (0..reps).map(move |r| (s, (s * 1000 + r) as i64 + seed * 1_000_000_007))).collect();
    let n = jobs.len();
    println!("STARTS {} from {} games, {} playouts, cut {cut}, leaf {}, base {base_spec} ({:.1}s)", starts.len(), gi, n, leaf.is_some(), t0.elapsed().as_secs_f64());

    // CPU reference
    let t1 = Instant::now();
    let cpu: Vec<(f64, [u32; 5])> = jobs
        .par_iter()
        .map(|&(s, sd)| {
            let g = starts[s];
            let me = g.b.p[g.current].owner;
            let st = streams_for(sd);
            let mut d = [Rng::seeded(st[0] as i64), Rng::seeded(st[1] as i64), Rng::seeded(st[2] as i64), Rng::seeded(st[3] as i64)];
            let mut r = Rng::seeded(st[4] as i64);
            let v = playout(g, &base, &base, me, &mut d, &mut r, cut, leaf.as_ref());
            (v, [d[0].state(), d[1].state(), d[2].state(), d[3].state(), r.state()])
        })
        .collect();
    let cpu_s = t1.elapsed().as_secs_f64();

    // GPU (warm-up launch first: NVRTC compile and module load)
    let gstarts: Vec<Game> = jobs.iter().map(|&(s, _)| starts[s]).collect();
    let mes: Vec<u8> = gstarts.iter().map(|g| g.b.p[g.current].owner).collect();
    {
        let mut w: Vec<[u32; 5]> = jobs.iter().take(64).map(|&(_, sd)| streams_for(sd)).collect();
        let _ = playouts(&gstarts[..w.len()], &mes[..w.len()], &mut w, cut, leaf.is_some(), &lb);
    }
    let mut gst: Vec<[u32; 5]> = jobs.iter().map(|&(_, sd)| streams_for(sd)).collect();
    let t2 = Instant::now();
    let outs = playouts(&gstarts, &mes, &mut gst, cut, leaf.is_some(), &lb);
    let gpu_s = t2.elapsed().as_secs_f64();
    let t3 = Instant::now();
    let gv: Vec<f64> = outs
        .par_iter()
        .zip(mes.par_iter())
        .map(|(o, &me)| match o {
            Out::Done(x) => *x,
            Out::Leaf(g) => {
                let mut v = [0.0f64; 4];
                leaf.as_ref().unwrap().owner_chances(g, &mut v);
                v[me as usize]
            }
        })
        .collect();
    let leaf_s = t3.elapsed().as_secs_f64();

    let mut bad_v = 0usize;
    let mut bad_s = 0usize;
    for k in 0..n {
        if cpu[k].0.to_bits() != gv[k].to_bits() {
            if bad_v < 5 {
                let (s, sd) = jobs[k];
                println!("MISMATCH value playout {k} start {s} seed {sd}: cpu {} gpu {}", cpu[k].0, gv[k]);
            }
            bad_v += 1;
        }
        if cpu[k].1 != gst[k] {
            if bad_s < 5 {
                println!("MISMATCH streams playout {k}: cpu {:?} gpu {:?}", cpu[k].1, gst[k]);
            }
            bad_s += 1;
        }
    }
    let leaves = outs.iter().filter(|o| matches!(o, Out::Leaf(_))).count();
    let mean = gv.iter().sum::<f64>() / n as f64;
    println!(
        "PARITY {{\"playouts\":{n},\"value_mismatches\":{bad_v},\"stream_mismatches\":{bad_s},\"leaves\":{leaves},\"mean\":{mean:.6},\"ok\":{}}}",
        bad_v == 0 && bad_s == 0
    );
    println!(
        "SPEED cpu {:.2}s ({:.0} playouts/s on {} threads)  gpu {:.2}s ({:.0} playouts/s, leaves valued on the CPU in {:.2}s more)  x{:.2}",
        cpu_s,
        n as f64 / cpu_s,
        rayon::current_num_threads(),
        gpu_s,
        n as f64 / gpu_s,
        leaf_s,
        cpu_s / gpu_s
    );
}
