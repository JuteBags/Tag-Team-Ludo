//! Rollout playouts on the GPU (playout.cu, NVRTC with --fmad=false), one thread per playout, bit-identical
//! to rollout.rs playout() when every seat plays a readable-rules search policy
//! (net:<linear.json>:1:<theirK>:0:0:<chance>: depth 1, temperature 0, no race database, no probe cut).
//! A playout that reaches the cut comes back as the position there; the caller values it with its leaf
//! evaluator exactly as playout() does (owner_chances of the mover's person), e.g. through eval::batch_values.
use crate::bot::Policy;
use crate::eval::Evaluator;
use crate::game::{Game, MAX_TRAY, PHASE_MOVE};
use cudarc::driver::{CudaContext, CudaFunction, CudaSlice, CudaStream, LaunchConfig, PushKernelArg};
use cudarc::nvrtc::{compile_ptx_with_opts, CompileOptions};
use std::sync::{Arc, Mutex, OnceLock};

/// Bytes per position record (playout.cu REC).
pub const REC: usize = 80;
/// Threads per block (the kernel is local-memory heavy; small blocks keep more of them resident).
const BLOCK: u32 = 64;
/// Per-thread stack for the turn search's recursion (bytes).
const STACK: usize = 32 * 1024;

/// The playout base: a readable-rules search at depth 1. w = 19 hand rules then 7 turn rules.
#[derive(Clone, Copy, Debug)]
pub struct LinearBase {
    pub w: [f64; 26],
    pub chance: u32,
}

impl LinearBase {
    /// The GPU form of a policy, if it has one (net:<linear>:1:<k>:0:0:<chance> with no probe cut).
    pub fn from_policy(p: &Policy) -> Option<LinearBase> {
        if let Policy::Search { eval, opts, temperature } = p {
            if let Evaluator::Linear(w, t) = &**eval {
                if opts.depth == 1 && *temperature == 0.0 && !opts.race && opts.cut <= 0.0 {
                    let mut all = [0.0; 26];
                    all[..19].copy_from_slice(w);
                    all[19..].copy_from_slice(t);
                    return Some(LinearBase { w: all, chance: opts.chance });
                }
            }
        }
        None
    }
}

/// One playout's outcome: finished (1 if the mover's person won, else 0), or the position at the cut.
#[derive(Clone, Debug)]
pub enum Out {
    Done(f64),
    Leaf(Game),
}

pub fn pack(g: &Game, r: &mut [u8]) {
    for x in r.iter_mut().take(REC) {
        *x = 0;
    }
    r[0] = g.b.n as u8;
    r[1] = g.current as u8;
    r[2] = g.phase;
    r[3] = g.sixes;
    r[4] = g.nrolls as u8;
    r[5] = g.singles as u8;
    r[6] = g.nrank as u8;
    for i in 0..4 {
        r[8 + i] = g.b.p[i].color;
        r[12 + i] = g.b.p[i].owner;
        for q in 0..4 {
            r[16 + 4 * i + q] = g.b.p[i].tokens[q] as u8;
        }
        r[72 + i] = g.b.idx[i];
        r[64 + i] = g.ranking[i];
    }
    r[32..32 + MAX_TRAY].copy_from_slice(&g.rolls);
    r[68..72].copy_from_slice(&g.turn_count.to_le_bytes());
}

/// The position in a record, on top of `like` (same seats and mode); its move list is regenerated.
pub fn unpack(r: &[u8], like: &Game) -> Game {
    let mut g = *like;
    g.b.n = r[0] as usize;
    g.current = r[1] as usize;
    g.phase = r[2];
    g.sixes = r[3];
    g.nrolls = r[4] as usize;
    g.singles = r[5] != 0;
    g.nrank = r[6] as usize;
    for i in 0..4 {
        g.b.p[i].color = r[8 + i];
        g.b.p[i].owner = r[12 + i];
        for q in 0..4 {
            g.b.p[i].tokens[q] = r[16 + 4 * i + q] as i8;
        }
        g.b.idx[i] = r[72 + i];
        g.ranking[i] = r[64 + i];
    }
    g.rolls.copy_from_slice(&r[32..32 + MAX_TRAY]);
    g.turn_count = u32::from_le_bytes([r[68], r[69], r[70], r[71]]);
    g.moves.clear();
    if g.phase == PHASE_MOVE {
        let color = g.b.p[g.current].color;
        let tray: Vec<u8> = g.tray().to_vec();
        crate::game::tray_moves(&g.b, color, &tray, g.singles, &mut g.moves);
    }
    g
}

#[derive(Default)]
struct Bufs {
    starts: Option<CudaSlice<u8>>,
    mes: Option<CudaSlice<u8>>,
    streams: Option<CudaSlice<u32>>,
    result: Option<CudaSlice<f64>>,
    leaves: Option<CudaSlice<u8>>,
    status: Option<CudaSlice<i32>>,
    w: Option<CudaSlice<f64>>,
}

struct Gpu {
    stream: Arc<CudaStream>,
    f: CudaFunction,
    bufs: Bufs,
}

static GPU: OnceLock<Mutex<Gpu>> = OnceLock::new();

fn gpu() -> &'static Mutex<Gpu> {
    GPU.get_or_init(|| {
        let ctx = CudaContext::new(0).expect("no CUDA device");
        let opts = CompileOptions { fmad: Some(false), ftz: Some(false), prec_div: Some(true), prec_sqrt: Some(true), ..Default::default() };
        let ptx = compile_ptx_with_opts(include_str!("playout.cu"), opts).expect("playout.cu does not compile");
        let module = ctx.load_module(ptx).unwrap();
        let f = module.load_function("playouts").unwrap();
        unsafe {
            let r = cudarc::driver::sys::cuCtxSetLimit(cudarc::driver::sys::CUlimit::CU_LIMIT_STACK_SIZE, STACK);
            assert_eq!(r, cudarc::driver::sys::CUresult::CUDA_SUCCESS, "cuCtxSetLimit stack size");
        }
        Mutex::new(Gpu { stream: ctx.default_stream(), f, bufs: Bufs::default() })
    })
}

fn ensure<T: cudarc::driver::DeviceRepr + cudarc::driver::ValidAsZeroBits>(st: &Arc<CudaStream>, d: &mut Option<CudaSlice<T>>, n: usize) {
    let n = n.max(1);
    if d.as_ref().map_or(true, |s| s.len() < n) {
        *d = Some(st.alloc_zeros::<T>(n + n / 2).unwrap());
    }
}

/// Runs the playouts: starts[i] from the mover's person mes[i], with streams[i] = (dice of seats 0-3,
/// the policy rng) as rng.rs states, updated in place as the CPU's would be. cut / has_eval as in
/// playout() (cut 0 = to the end; at the cut only when there is a leaf evaluator).
pub fn playouts(starts: &[Game], mes: &[u8], streams: &mut [[u32; 5]], cut: u32, has_eval: bool, base: &LinearBase) -> Vec<Out> {
    let n = starts.len();
    assert!(mes.len() == n && streams.len() == n);
    if n == 0 {
        return Vec::new();
    }
    let people = starts[0].b.players().iter().map(|p| p.owner).max().unwrap() as i32 + 1;
    assert!(starts.iter().all(|g| g.b.players().iter().map(|p| p.owner).max().unwrap() as i32 + 1 == people), "one mode per batch");
    let mut recs = vec![0u8; n * REC];
    for (i, g) in starts.iter().enumerate() {
        pack(g, &mut recs[i * REC..(i + 1) * REC]);
    }
    let flat: Vec<u32> = streams.iter().flat_map(|s| s.iter().copied()).collect();
    let mut guard = gpu().lock().unwrap();
    let gl = &mut *guard;
    let st = gl.stream.clone();
    let b = &mut gl.bufs;
    ensure(&st, &mut b.starts, n * REC);
    ensure(&st, &mut b.mes, n);
    ensure(&st, &mut b.streams, n * 5);
    ensure(&st, &mut b.result, n);
    ensure(&st, &mut b.leaves, n * REC);
    ensure(&st, &mut b.status, n);
    ensure(&st, &mut b.w, 26);
    st.memcpy_htod(&recs, b.starts.as_mut().unwrap()).unwrap();
    st.memcpy_htod(mes, b.mes.as_mut().unwrap()).unwrap();
    st.memcpy_htod(&flat, b.streams.as_mut().unwrap()).unwrap();
    st.memcpy_htod(&base.w, b.w.as_mut().unwrap()).unwrap();
    let cfg = LaunchConfig { grid_dim: ((n as u32).div_ceil(BLOCK), 1, 1), block_dim: (BLOCK, 1, 1), shared_mem_bytes: 0 };
    let (n_i, cut_i, he_i, ch_i) = (n as i32, cut as i32, has_eval as i32, base.chance as i32);
    let mut lb = st.launch_builder(&gl.f);
    lb.arg(b.starts.as_ref().unwrap())
        .arg(b.mes.as_ref().unwrap())
        .arg(b.streams.as_mut().unwrap())
        .arg(&n_i)
        .arg(&cut_i)
        .arg(&he_i)
        .arg(b.w.as_ref().unwrap())
        .arg(&ch_i)
        .arg(&people)
        .arg(b.result.as_mut().unwrap())
        .arg(b.leaves.as_mut().unwrap())
        .arg(b.status.as_mut().unwrap());
    unsafe { lb.launch(cfg) }.unwrap();
    let mut result = vec![0.0f64; n];
    let mut status = vec![0i32; n];
    let mut leaves = vec![0u8; n * REC];
    let mut flat_out = vec![0u32; n * 5];
    st.memcpy_dtoh(&b.result.as_ref().unwrap().slice(0..n), &mut result).unwrap();
    st.memcpy_dtoh(&b.status.as_ref().unwrap().slice(0..n), &mut status).unwrap();
    st.memcpy_dtoh(&b.leaves.as_ref().unwrap().slice(0..n * REC), &mut leaves).unwrap();
    st.memcpy_dtoh(&b.streams.as_ref().unwrap().slice(0..n * 5), &mut flat_out).unwrap();
    st.synchronize().unwrap();
    drop(guard);
    for (i, s) in streams.iter_mut().enumerate() {
        s.copy_from_slice(&flat_out[i * 5..i * 5 + 5]);
    }
    (0..n)
        .map(|i| match status[i] {
            0 => Out::Done(result[i]),
            1 => Out::Leaf(unpack(&leaves[i * REC..(i + 1) * REC], &starts[i])),
            e => panic!("playout {i}: GPU internal limit hit (status {e})"),
        })
        .collect()
}
