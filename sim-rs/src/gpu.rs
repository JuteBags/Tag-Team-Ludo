//! The batch leaf evaluator on an NVIDIA GPU (cargo features cuda12 / cuda13): net.cu through NVRTC
//! (--fmad=false), f64, one block per position, bit-identical to Evaluator::owner_chances. The CPU
//! encodes each position (encode.rs) and sends only its non-zero trunk inputs; the GPU returns the head's
//! score per person, and eval::chances_from_scores turns those into chances exactly as the CPU path does.
//!
//! Host side: two parallel passes (count the non-zeros, then write them in place) into buffers that live
//! as long as the process and only grow, on the host and on the device. Allocating per position, or per
//! batch, is what made the first version slow: page faults and allocations are expensive in a sandbox.
use crate::encode::{encode, D};
use crate::eval::{chances_from_scores, Evaluator};
use crate::game::Game;
use cudarc::driver::{CudaContext, CudaFunction, CudaSlice, CudaStream, DeviceRepr, LaunchConfig, PushKernelArg, ValidAsZeroBits};
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

/// Host and device buffers, reused batch after batch (grow only).
#[derive(Default)]
struct Bufs {
    counts: Vec<u32>,
    start: Vec<i32>,
    meta: Vec<i32>,
    idx: Vec<i32>,
    val: Vec<f64>,
    scores: Vec<f64>,
    d_meta: Option<CudaSlice<i32>>,
    d_start: Option<CudaSlice<i32>>,
    d_idx: Option<CudaSlice<i32>>,
    d_val: Option<CudaSlice<f64>>,
    d_scores: Option<CudaSlice<f64>>,
}

struct Gpu {
    stream: Arc<CudaStream>,
    f: CudaFunction,
    /// nets already on the device, by evaluator address (the policies hold them for the whole run)
    nets: HashMap<usize, Loaded>,
    bufs: Bufs,
}

static GPU: OnceLock<Mutex<Gpu>> = OnceLock::new();

fn gpu() -> &'static Mutex<Gpu> {
    GPU.get_or_init(|| {
        let ctx = CudaContext::new(0).expect("no CUDA device");
        let opts = CompileOptions { fmad: Some(false), ftz: Some(false), prec_div: Some(true), prec_sqrt: Some(true), ..Default::default() };
        let ptx = compile_ptx_with_opts(include_str!("net.cu"), opts).expect("net.cu does not compile");
        let module = ctx.load_module(ptx).unwrap();
        let f = module.load_function("net_scores").unwrap();
        Mutex::new(Gpu { stream: ctx.default_stream(), f, nets: HashMap::new(), bufs: Bufs::default() })
    })
}

/// A device buffer holding at least `n` elements (reallocated 1.5x larger when too small).
fn ensure<T: DeviceRepr + ValidAsZeroBits>(st: &Arc<CudaStream>, d: &mut Option<CudaSlice<T>>, n: usize) {
    let n = n.max(1);
    if d.as_ref().map_or(true, |s| s.len() < n) {
        *d = Some(st.alloc_zeros::<T>(n + n / 2).unwrap());
    }
}

/// Raw pointer for disjoint parallel writes.
#[derive(Clone, Copy)]
struct Ptr<T>(*mut T);
unsafe impl<T> Send for Ptr<T> {}
unsafe impl<T> Sync for Ptr<T> {}

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
            _ => {
                // linear rules and blends: on the CPU
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
        let np = pos.len();
        let mut guard = gpu().lock().unwrap();
        let gl = &mut *guard;
        if !gl.nets.contains_key(&addr) {
            let e = net.export();
            let w = gl.stream.clone_htod(&e.weights).unwrap();
            let layers = gl.stream.clone_htod(&e.layers).unwrap();
            gl.nets.insert(addr, Loaded { w, layers, ntrunk: e.ntrunk as i32, inputs: e.inputs });
        }
        let prof = std::env::var_os("LUDO_GPU_PROF").is_some();
        let t0 = std::time::Instant::now();
        let st = gl.stream.clone();
        let net_d = &gl.nets[&addr];
        let inputs: &[usize] = &net_d.inputs;
        let b = &mut gl.bufs;

        // pass A: per position, its colours' owners and how many non-zero inputs each colour has
        b.counts.resize(np * 4, 0);
        b.meta.resize(np * 6, 0);
        b.counts.par_chunks_mut(4).zip(b.meta.par_chunks_mut(6)).zip(pos.par_iter()).with_min_len(64).for_each(|((cnt, meta), &(i, j))| {
            let g = &leaves[i][j];
            let mut x = [0.0f64; 4 * D];
            encode(&g.b, g.current, g.singles, g.tray(), g.sixes, &mut x);
            let ps = g.b.players();
            meta[0] = g.b.n as i32;
            meta[1] = ps.iter().map(|p| p.owner).max().unwrap() as i32 + 1;
            for c in 0..4 {
                meta[2 + c] = if c < g.b.n { ps[c].owner as i32 } else { -1 };
                cnt[c] = if c < g.b.n { inputs.iter().filter(|&&ix| x[c * D + ix] != 0.0).count() as u32 } else { 0 };
            }
        });
        // where colour c of position p starts
        b.start.resize(np * 4 + 1, 0);
        let mut acc = 0i32;
        for k in 0..np * 4 {
            b.start[k] = acc;
            acc += b.counts[k] as i32;
        }
        b.start[np * 4] = acc;
        let total = acc as usize;
        let t_a = t0.elapsed().as_secs_f64();

        // pass B: the non-zero inputs, written in place
        b.idx.resize(total.max(1), 0);
        b.val.resize(total.max(1), 0.0);
        let (pi, pv) = (Ptr(b.idx.as_mut_ptr()), Ptr(b.val.as_mut_ptr()));
        let start = &b.start;
        pos.par_iter().enumerate().with_min_len(64).for_each(|(p, &(i, j))| {
            let (pi, pv) = (pi, pv);
            let g = &leaves[i][j];
            let mut x = [0.0f64; 4 * D];
            encode(&g.b, g.current, g.singles, g.tray(), g.sixes, &mut x);
            let mut q = start[p * 4] as usize;
            for c in 0..g.b.n {
                for (k, &ix) in inputs.iter().enumerate() {
                    let v = x[c * D + ix];
                    if v != 0.0 {
                        // SAFETY: q stays inside this position's own range start[p*4] .. start[p*4+4]
                        unsafe {
                            *pi.0.add(q) = k as i32;
                            *pv.0.add(q) = v;
                        }
                        q += 1;
                    }
                }
            }
        });
        let t_b = t0.elapsed().as_secs_f64();

        // upload, run, download
        ensure(&st, &mut b.d_meta, np * 6);
        ensure(&st, &mut b.d_start, np * 4 + 1);
        ensure(&st, &mut b.d_idx, total);
        ensure(&st, &mut b.d_val, total);
        ensure(&st, &mut b.d_scores, np * 4);
        st.memcpy_htod(&b.meta[..np * 6], b.d_meta.as_mut().unwrap()).unwrap();
        st.memcpy_htod(&b.start[..np * 4 + 1], b.d_start.as_mut().unwrap()).unwrap();
        st.memcpy_htod(&b.idx[..total.max(1)], b.d_idx.as_mut().unwrap()).unwrap();
        st.memcpy_htod(&b.val[..total.max(1)], b.d_val.as_mut().unwrap()).unwrap();
        if prof {
            st.synchronize().unwrap();
        }
        let t_h2d = t0.elapsed().as_secs_f64();
        let npos = np as i32;
        let cfg = LaunchConfig { grid_dim: (np as u32, 1, 1), block_dim: (128, 1, 1), shared_mem_bytes: 0 };
        let mut lb = st.launch_builder(&gl.f);
        lb.arg(&net_d.w)
            .arg(&net_d.layers)
            .arg(&net_d.ntrunk)
            .arg(b.d_meta.as_ref().unwrap())
            .arg(b.d_start.as_ref().unwrap())
            .arg(b.d_idx.as_ref().unwrap())
            .arg(b.d_val.as_ref().unwrap())
            .arg(b.d_scores.as_mut().unwrap())
            .arg(&npos);
        unsafe { lb.launch(cfg) }.unwrap();
        if prof {
            st.synchronize().unwrap();
        }
        let t_kernel = t0.elapsed().as_secs_f64();
        b.scores.resize(np * 4, 0.0);
        st.memcpy_dtoh(&b.d_scores.as_ref().unwrap().slice(0..np * 4), &mut b.scores[..np * 4]).unwrap();
        st.synchronize().unwrap();
        let t_d2h = t0.elapsed().as_secs_f64();

        // chances from the scores, exactly as owner_chances finishes
        let scores = &b.scores;
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
                "GPUPROF positions {np} nnz/pos {:.1} count {:.1}ms write {:.1}ms h2d {:.1}ms kernel {:.1}ms d2h {:.1}ms finish {:.1}ms",
                total as f64 / np as f64,
                t_a * 1e3,
                (t_b - t_a) * 1e3,
                (t_h2d - t_b) * 1e3,
                (t_kernel - t_h2d) * 1e3,
                (t_d2h - t_kernel) * 1e3,
                (t - t_d2h) * 1e3
            );
        }
    }
    out
}
