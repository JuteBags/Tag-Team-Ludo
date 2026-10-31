//! The batch leaf evaluator on an NVIDIA GPU (cargo feature "cuda"): net.cu through NVRTC (--fmad=false),
//! f64, one block per position, bit-identical to Evaluator::owner_chances. The CPU encodes each
//! position (encode.rs) and sends only its non-zero trunk inputs; the GPU returns the head's score per
//! person, and eval::chances_from_scores turns those into chances exactly as the CPU path does.
use crate::encode::{encode, D};
use crate::eval::{chances_from_scores, Evaluator};
use crate::game::Game;
use cudarc::driver::{CudaContext, CudaFunction, CudaSlice, CudaStream, LaunchConfig, PushKernelArg};
use cudarc::nvrtc::{compile_ptx_with_opts, CompileOptions};
use rayon::prelude::*;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

struct Loaded {
    w: CudaSlice<f64>,
    layers: CudaSlice<i32>,
    ntrunk: i32,
    inputs: Vec<usize>,
}

struct Gpu {
    stream: Arc<CudaStream>,
    f: CudaFunction,
    /// nets already on the device, by evaluator address (the policies hold them for the whole run)
    nets: HashMap<usize, Loaded>,
}

static GPU: OnceLock<Mutex<Gpu>> = OnceLock::new();

fn gpu() -> &'static Mutex<Gpu> {
    GPU.get_or_init(|| {
        let ctx = CudaContext::new(0).expect("no CUDA device");
        let opts = CompileOptions { fmad: Some(false), ftz: Some(false), prec_div: Some(true), prec_sqrt: Some(true), ..Default::default() };
        let ptx = compile_ptx_with_opts(include_str!("net.cu"), opts).expect("net.cu does not compile");
        let module = ctx.load_module(ptx).unwrap();
        let f = module.load_function("net_scores").unwrap();
        Mutex::new(Gpu { stream: ctx.default_stream(), f, nets: HashMap::new() })
    })
}

/// The non-zero trunk inputs of one position, colour by colour (index into the net's inputs, value).
fn sparse(g: &Game, inputs: &[usize]) -> (Vec<i32>, Vec<f64>, [usize; 4]) {
    let mut x = [0.0f64; 4 * D];
    encode(&g.b, g.current, g.singles, g.tray(), g.sixes, &mut x);
    let (mut idx, mut val, mut ends) = (Vec::new(), Vec::new(), [0usize; 4]);
    for i in 0..g.b.n {
        for (k, &ix) in inputs.iter().enumerate() {
            let v = x[i * D + ix];
            if v != 0.0 {
                idx.push(k as i32);
                val.push(v);
            }
        }
        ends[i] = idx.len();
    }
    for i in g.b.n..4 {
        ends[i] = idx.len();
    }
    (idx, val, ends)
}

/// eval::batch_values on the GPU: nets on the device, linear rules on the CPU.
pub fn batch_values(evals: &[&Evaluator], leaves: &[Vec<Game>]) -> Vec<Vec<[f64; 4]>> {
    let mut out: Vec<Vec<[f64; 4]>> = leaves.iter().map(|ls| vec![[0.0; 4]; ls.len()]).collect();
    // group the decisions by evaluator
    let mut groups: Vec<(usize, Vec<usize>)> = Vec::new();
    for (i, e) in evals.iter().enumerate() {
        let a = *e as *const Evaluator as usize;
        match groups.iter_mut().find(|g| g.0 == a) {
            Some(g) => g.1.push(i),
            None => groups.push((a, vec![i])),
        }
    }
    for (addr, ids) in groups {
        let ev = evals[ids[0]];
        let net = match ev {
            Evaluator::Net(n) => n,
            Evaluator::Linear(..) => {
                for &i in &ids {
                    for (j, g) in leaves[i].iter().enumerate() {
                        ev.owner_chances(g, &mut out[i][j]);
                    }
                }
                continue;
            }
        };
        let pos: Vec<(usize, usize)> = ids.iter().flat_map(|&i| (0..leaves[i].len()).map(move |j| (i, j))).collect();
        if pos.is_empty() {
            continue;
        }
        let mut gl = gpu().lock().unwrap();
        if !gl.nets.contains_key(&addr) {
            let e = net.export();
            let w = gl.stream.clone_htod(&e.weights).unwrap();
            let layers = gl.stream.clone_htod(&e.layers).unwrap();
            gl.nets.insert(addr, Loaded { w, layers, ntrunk: e.ntrunk as i32, inputs: e.inputs });
        }
        let inputs = gl.nets[&addr].inputs.clone();
        let prof = std::env::var_os("LUDO_GPU_PROF").is_some();
        let t0 = std::time::Instant::now();
        let parts: Vec<(Vec<i32>, Vec<f64>, [usize; 4])> = pos.par_iter().with_min_len(64).map(|&(i, j)| sparse(&leaves[i][j], &inputs)).collect();
        let t_sparse = t0.elapsed().as_secs_f64();
        let mut meta = Vec::with_capacity(pos.len() * 6);
        let mut start = Vec::with_capacity(pos.len() * 4 + 1);
        let total: usize = parts.iter().map(|p| p.0.len()).sum();
        let (mut idx, mut val) = (Vec::with_capacity(total), Vec::with_capacity(total));
        for (&(i, j), (pi, pv, ends)) in pos.iter().zip(&parts) {
            let g = &leaves[i][j];
            let ps = g.b.players();
            let people = ps.iter().map(|p| p.owner).max().unwrap() as i32 + 1;
            meta.push(g.b.n as i32);
            meta.push(people);
            for c in 0..4 {
                meta.push(if c < g.b.n { ps[c].owner as i32 } else { -1 });
            }
            let base = idx.len();
            let mut from = 0;
            for c in 0..4 {
                start.push((base + from) as i32);
                from = ends[c];
            }
            idx.extend_from_slice(pi);
            val.extend_from_slice(pv);
        }
        start.push(idx.len() as i32);
        // start[p*4+i] .. start[p*4+i+1]: colour i of position p (the next colour's start, or the next
        // position's first colour, is that colour's end)
        let npos = pos.len() as i32;
        let t_pack = t0.elapsed().as_secs_f64();
        let st = gl.stream.clone();
        let d_meta = st.clone_htod(&meta).unwrap();
        let d_start = st.clone_htod(&start).unwrap();
        let d_idx = st.clone_htod(if idx.is_empty() { &[0i32][..] } else { &idx[..] }).unwrap();
        let d_val = st.clone_htod(if val.is_empty() { &[0.0f64][..] } else { &val[..] }).unwrap();
        let mut d_scores = st.alloc_zeros::<f64>(pos.len() * 4).unwrap();
        if prof {
            st.synchronize().unwrap();
        }
        let t_h2d = t0.elapsed().as_secs_f64();
        let net_d = &gl.nets[&addr];
        let cfg = LaunchConfig { grid_dim: (pos.len() as u32, 1, 1), block_dim: (128, 1, 1), shared_mem_bytes: 0 };
        let mut lb = st.launch_builder(&gl.f);
        lb.arg(&net_d.w).arg(&net_d.layers).arg(&net_d.ntrunk).arg(&d_meta).arg(&d_start).arg(&d_idx).arg(&d_val).arg(&mut d_scores).arg(&npos);
        unsafe { lb.launch(cfg) }.unwrap();
        if prof {
            st.synchronize().unwrap();
        }
        let t_kernel = t0.elapsed().as_secs_f64();
        let scores = st.clone_dtoh(&d_scores).unwrap();
        let t_d2h = t0.elapsed().as_secs_f64();
        drop(gl);
        let vals: Vec<[f64; 4]> = pos
            .par_iter()
            .enumerate()
            .with_min_len(256)
            .map(|(q, &(i, j))| {
                let g = &leaves[i][j];
                let people = g.b.players().iter().map(|p| p.owner).max().unwrap() as usize + 1;
                let mut s = [scores[q * 4], scores[q * 4 + 1], scores[q * 4 + 2], scores[q * 4 + 3]];
                let mut v = [0.0; 4];
                chances_from_scores(g, people, &mut s, &mut v);
                v
            })
            .collect();
        for (&(i, j), v) in pos.iter().zip(vals) {
            out[i][j] = v;
        }
        if prof {
            let t = t0.elapsed().as_secs_f64();
            eprintln!(
                "GPUPROF positions {} nnz/pos {:.1} sparse {:.1}ms pack {:.1}ms h2d {:.1}ms kernel {:.1}ms d2h {:.1}ms finish {:.1}ms",
                pos.len(),
                total as f64 / pos.len() as f64,
                t_sparse * 1e3,
                (t_pack - t_sparse) * 1e3,
                (t_h2d - t_pack) * 1e3,
                (t_kernel - t_h2d) * 1e3,
                (t_d2h - t_kernel) * 1e3,
                (t - t_d2h) * 1e3
            );
        }
    }
    out
}
