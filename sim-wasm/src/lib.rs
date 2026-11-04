//! The rollout Extreme for the app (src/engine/ai/rollout-worker.ts runs it in a Web Worker): sim-rs's
//! adaptive rollout player, race:<nmax>:12:<net>:<hard rules, chance 1>, behind a C ABI so the module
//! needs no bindings generator. The host copies bytes in through `alloc`, then:
//!   init(net json, rules json)  once, the leaf net and Hard's rules (both as JSON text)
//!   init_bin(net bytes, rules json)  the same, with the net as extreme-net.bin (#98: no JSON parse)
//!   choose(state, nmax, seed)   the index into state.moves of the move to play
//!   review(state, n, seed)      the game review's values for one decision (#65), as f64s at the returned
//!                               pointer: moves, candidates, best, then each move's candidate, then per
//!                               candidate its mean, its gap below the best and that gap's standard error
//!   review_fast(state, n, seed, played, mode, skip, z, best)   the review's net screen (mode 1) or race (mode 2) (#101),
//!                               in review's layout with two more header fields and a playout count per
//!                               candidate (see the function)
//! The state bytes (encodeState in rollout-worker.ts), all u8 unless noted:
//!   n, singles, current, phase, nrolls, sixes, nrank, ranking[4], turn_count (u32 LE), rolls[nrolls],
//!   then per player in colour order: colour index, owner, tokens[4] (i8: -1 base .. 56 finished).
//! The moves are regenerated here (game.rs tray_moves on the tray); their order is the TS engine's, the
//! same as every sim-rs trace, so the index means the same move on both sides.
use ludo_sim::bot::Policy;
use ludo_sim::eval::Evaluator;
use ludo_sim::game::{tray_moves, Game, PHASE_MOVE, PHASE_ROLL};
use ludo_sim::rng::Rng;
use ludo_sim::rules::{Board, Player};
use ludo_sim::search::SearchOptions;
use std::cell::RefCell;
use std::sync::Arc;

/// Playout length in turns, then the net scores the position (as the measured race player).
const CUT: u32 = 12;

struct Engine {
    net: Evaluator,
    base: Policy,
}

thread_local! {
    static ENGINE: RefCell<Option<Engine>> = const { RefCell::new(None) };
}

/// A buffer of `len` bytes for the host to write into (freed by the call that takes it).
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

unsafe fn take(ptr: *mut u8, len: usize) -> Vec<u8> {
    Vec::from_raw_parts(ptr, len, len.max(1))
}

/// Loads the leaf net and Hard's rules (JSON texts in buffers from `alloc`). Returns 1.
#[no_mangle]
pub unsafe extern "C" fn init(net: *mut u8, net_len: usize, rules: *mut u8, rules_len: usize) -> i32 {
    let net = String::from_utf8(take(net, net_len)).unwrap();
    let rules = String::from_utf8(take(rules, rules_len)).unwrap();
    let opts = SearchOptions { depth: 1, chance: 1, their_k: 3, race: false, cut: 0.0 };
    let base = Policy::Search { eval: Arc::new(Evaluator::from_json_text(&rules)), opts, temperature: 0.0 };
    ENGINE.with(|e| *e.borrow_mut() = Some(Engine { net: Evaluator::from_json_text(&net), base }));
    1
}

/// init() with the leaf net as extreme-net.bin's bytes (src/engine/ai/netbin.ts; the same weights as the
/// JSON, so every value is the same) and Hard's rules as JSON text. Returns 1.
#[no_mangle]
pub unsafe extern "C" fn init_bin(net: *mut u8, net_len: usize, rules: *mut u8, rules_len: usize) -> i32 {
    let net = take(net, net_len);
    let rules = String::from_utf8(take(rules, rules_len)).unwrap();
    let opts = SearchOptions { depth: 1, chance: 1, their_k: 3, race: false, cut: 0.0 };
    let base = Policy::Search { eval: Arc::new(Evaluator::from_json_text(&rules)), opts, temperature: 0.0 };
    ENGINE.with(|e| *e.borrow_mut() = Some(Engine { net: Evaluator::from_bin(&net), base }));
    1
}

/// Rebuilds a sim-rs Game from the state bytes (layout in the module doc).
pub fn decode(s: &[u8]) -> Game {
    let n = s[0] as usize;
    let nrolls = s[4] as usize;
    let mut o = 15 + nrolls;
    let mut seats = Vec::with_capacity(n);
    for j in 0..n {
        seats.push((s[o + 6 * j], s[o + 6 * j + 1]));
    }
    let mut g = Game::new(&seats, s[1] != 0);
    for j in 0..n {
        let p: &mut Player = &mut g.b.p[j];
        for t in 0..4 {
            p.tokens[t] = s[o + 2 + t] as i8;
        }
        o += 6;
    }
    g.current = s[2] as usize;
    g.phase = s[3];
    g.nrolls = nrolls;
    g.rolls[..nrolls].copy_from_slice(&s[15..15 + nrolls]);
    g.sixes = s[5];
    g.nrank = s[6] as usize;
    g.ranking.copy_from_slice(&s[7..11]);
    g.turn_count = u32::from_le_bytes([s[11], s[12], s[13], s[14]]);
    if g.phase == PHASE_MOVE {
        let b: Board = g.b;
        tray_moves(&b, g.current_color(), &g.rolls[..nrolls], g.singles, &mut g.moves);
    }
    g
}

/// The move to play, as an index into the state's moves: the adaptive rollout player with up to `nmax`
/// paired playouts per candidate, its dice drawn from `seed`. -1 if init was not called.
#[no_mangle]
pub unsafe extern "C" fn choose(state: *mut u8, len: usize, nmax: u32, seed: u32) -> i32 {
    let s = take(state, len);
    let g = decode(&s);
    ENGINE.with(|e| match e.borrow().as_ref() {
        Some(eng) => {
            let mut rng = Rng::seeded(seed as i64);
            ludo_sim::rollout::choose_race(&g, &mut rng, nmax as usize, CUT, Some(&eng.net), &eng.base, &eng.base) as i32
        }
        None => -1,
    })
}

/// Number of moves the decoded state has (a host-side check that both engines agree).
#[no_mangle]
pub unsafe extern "C" fn moves_len(state: *mut u8, len: usize) -> i32 {
    decode(&take(state, len)).moves.len() as i32
}

thread_local! {
    static REVIEW: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) };
    /// The last decision reviewed or raced (its state bytes and seed) and every playout made for it, so a
    /// top-up of the same decision only adds the new playouts (rollout.rs review_cached; the same result).
    static PLAYED: RefCell<(Vec<u8>, u32, Vec<Vec<f64>>)> = const { RefCell::new((Vec::new(), 0, Vec::new())) };
}

/// The playouts kept for this decision and seed (empty for another one).
fn kept(s: &[u8], seed: u32) -> Vec<Vec<f64>> {
    PLAYED.with(|k| {
        let mut k = k.borrow_mut();
        if k.0 == s && k.1 == seed {
            std::mem::take(&mut k.2)
        } else {
            Vec::new()
        }
    })
}

fn keep(s: Vec<u8>, seed: u32, res: Vec<Vec<f64>>) {
    PLAYED.with(|k| *k.borrow_mut() = (s, seed, res));
}

/// The fast review of one decision (#101), as f64s at the returned pointer, valid until the next call:
/// [moves, candidates, best, complete, stop, candidate of each move ..., then mean, gap, se, playouts per
/// candidate ...]. `mode` 1: the net screen (rollout.rs screen: mean = the net's value, gap = below the net's
/// best, se and playouts 0; `n`, `seed` and `played` unused). `mode` 2: the race (rollout.rs review_race) up
/// to `n` playouts, the move played being `played` (an index into the state's moves); when `complete` is 1
/// the values are exactly review(state, n, seed)'s. With `skip` > 0 the race first screens: if the net's
/// spread (best minus worst, a fraction) is under `skip`, it returns the screen's values with stop 3 and no
/// playouts. `z` is the race's bound for settling Best (rollout.rs review_race; 0: its default schedule), and
/// `best` the Best cut it settles within (a fraction; 0: rollout.rs BEST_WITHIN).
/// 0 if init was not called or `mode` is unknown.
#[no_mangle]
pub unsafe extern "C" fn review_fast(state: *mut u8, len: usize, n: u32, seed: u32, played: u32, mode: u32, skip: f64, z: f64, best: f64) -> *const f64 {
    let s = take(state, len);
    let g = decode(&s);
    ENGINE.with(|e| match e.borrow().as_ref() {
        Some(eng) => {
            let screened = || {
                let (of_move, vals) = ludo_sim::rollout::screen(&g, &eng.net, &eng.base);
                let nc = vals.len();
                let best = (0..nc).fold(0, |b, c| if vals[c] > vals[b] { c } else { b });
                let gap: Vec<f64> = vals.iter().map(|v| vals[best] - v).collect();
                ludo_sim::rollout::Review { of_move, mean: vals, gap, se: vec![0.0; nc], best }
            };
            // The race's own screen: nothing at stake by the net (a spread under `skip`) means no playouts.
            let pre = if mode == 2 && skip > 0.0 {
                let r = screened();
                (r.mean.len() > 1 && r.gap.iter().cloned().fold(0.0, f64::max) < skip).then_some(r)
            } else {
                None
            };
            let (r, count, complete, stop) = match (mode, pre) {
                (1, _) => {
                    let r = screened();
                    let nc = r.mean.len();
                    (r, vec![0usize; nc], true, 0u8)
                }
                (2, Some(r)) => {
                    let nc = r.mean.len();
                    (r, vec![0usize; nc], false, 3u8)
                }
                (2, None) => {
                    let f = ludo_sim::rollout::review_race(&g, seed as i64, n as usize, CUT, Some(&eng.net), &eng.base, played as usize, z, best);
                    keep(s.clone(), seed, f.res);
                    (f.review, f.count, f.complete, f.stop)
                }
                _ => return std::ptr::null(),
            };
            REVIEW.with(|out| {
                let mut o = out.borrow_mut();
                o.clear();
                o.extend([r.of_move.len() as f64, r.mean.len() as f64, r.best as f64, complete as u8 as f64, stop as f64]);
                o.extend(r.of_move.iter().map(|&c| c as f64));
                for c in 0..r.mean.len() {
                    o.extend([r.mean[c], r.gap[c], r.se[c], count[c] as f64]);
                }
                o.as_ptr()
            })
        }
        None => std::ptr::null(),
    })
}

/// The review of one decision (rollout.rs review: `n` paired playouts per distinct move, no early stop), as
/// f64s at the returned pointer, valid until the next call: [moves, candidates, best, candidate of each move
/// ..., then mean, gap, se per candidate ...]. 0 if init was not called.
#[no_mangle]
pub unsafe extern "C" fn review(state: *mut u8, len: usize, n: u32, seed: u32) -> *const f64 {
    let s = take(state, len);
    let g = decode(&s);
    ENGINE.with(|e| match e.borrow().as_ref() {
        Some(eng) => {
            let mut res = kept(&s, seed);
            let r = ludo_sim::rollout::review_cached(&g, seed as i64, n as usize, CUT, Some(&eng.net), &eng.base, &mut res);
            keep(s.clone(), seed, res);
            REVIEW.with(|out| {
                let mut o = out.borrow_mut();
                o.clear();
                o.extend([r.of_move.len() as f64, r.mean.len() as f64, r.best as f64]);
                o.extend(r.of_move.iter().map(|&c| c as f64));
                for c in 0..r.mean.len() {
                    o.extend([r.mean[c], r.gap[c], r.se[c]]);
                }
                o.as_ptr()
            })
        }
        None => std::ptr::null(),
    })
}

// The review's luck pass (#125): the net and search values behind review.ts rollLuck and netChances, so the
// worker needn't run the net in JS. Only the values come from here; the luck arithmetic (the faces' chances,
// the expectation, the sd, the rounding) stays in review.ts. A game's pass is
//   luck_begin()   once: an empty leaf cache (positions valued in this game, by search.rs leaf_key; emptied
//                  before each roll's six faces, where nearly all its repeats are, and capped)
//   luck_chunk(states, len, count, kind)   any number of times, ~64 states each, so the worker can stop
//                  between chunks; `states` is `count` state byte strings (the module doc's layout), each
//                  after its length as a u16 LE. kind 0: per state, the roller's chance after each face 1..6
//                  (review.ts chanceAfter: the best of search_values(depth 1, chance 0) while the roller
//                  still moves, else the evaluator's value), 6 f64s; kind 1: per state, ownerValues, 4 f64s
//                  (people = max owner + 1 of them used). At the returned pointer until the next call; null
//                  without init or luck_begin.
//   luck_end()     frees the cache.
// Every value is the evaluator's own (eval.rs: net.ts's sums, V8's tanh and exp), and a cached value is the
// one computed before for that position, so the values are exactly the TS net's.

/// Most positions the luck cache holds before it starts over. It is also emptied before each roll's six
/// faces (#125: 50.1% of the leaf values repeat within one roll's faces, 53.5% across the whole game, so the
/// small cache keeps nearly every repeat and the module's memory stays small).
const LUCK_MAX: usize = 2048;

thread_local! {
    static LUCK: RefCell<Option<ludo_sim::search::Map<[f64; 4]>>> = const { RefCell::new(None) };
    static LUCK_OUT: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) };
    /// The cache's largest size since the module loaded (positions), for the memory report.
    static LUCK_PEAK: RefCell<usize> = const { RefCell::new(0) };
}

/// Starts a game's luck pass: an empty leaf cache. Returns 1.
#[no_mangle]
pub extern "C" fn luck_begin() -> i32 {
    LUCK.with(|l| *l.borrow_mut() = Some(Default::default()));
    1
}

/// Ends a game's luck pass: the cache and the output buffer are freed.
#[no_mangle]
pub extern "C" fn luck_end() {
    LUCK.with(|l| *l.borrow_mut() = None);
    LUCK_OUT.with(|o| *o.borrow_mut() = Vec::new());
}

/// Positions in the luck cache now (0 without luck_begin).
#[no_mangle]
pub extern "C" fn luck_size() -> u32 {
    LUCK.with(|l| l.borrow().as_ref().map_or(0, |m| m.len()) as u32)
}

/// The luck cache's largest size since the module loaded.
#[no_mangle]
pub extern "C" fn luck_peak() -> u32 {
    LUCK_PEAK.with(|p| *p.borrow() as u32)
}

/// The roller's chance after `face` at `g` (a roll state): review.ts chanceAfter, operation for operation.
fn chance_after(net: &Evaluator, g: &Game, face: u8, leaves: &mut ludo_sim::search::Map<[f64; 4]>) -> f64 {
    let owner = g.b.p[g.current].owner as usize;
    let mut t = *g;
    t.roll(face);
    if t.phase == PHASE_MOVE && t.current == g.current {
        let opts = SearchOptions { depth: 1, chance: 0, their_k: 3, race: false, cut: 0.0 };
        // Math.max(...values)
        let mut best = f64::NEG_INFINITY;
        for v in ludo_sim::search::search_values_keep(net, &t, opts, leaves) {
            best = ludo_sim::jsmath::max(best, v);
        }
        best
    } else if t.phase == PHASE_ROLL && t.current == g.current {
        // A 6 that rolls again (#135): the expectation over the next face, as review.ts chanceAfter.
        let mut e = 0.0;
        for f in 1..=6u8 {
            e += chance_after(net, &t, f, leaves) / 6.0;
        }
        e
    } else {
        ludo_sim::search::owner_values_keep(net, &t, leaves)[owner]
    }
}

/// One chunk of a game's luck pass (see above).
#[no_mangle]
pub unsafe extern "C" fn luck_chunk(states: *mut u8, len: usize, count: u32, kind: u32) -> *const f64 {
    let buf = take(states, len);
    ENGINE.with(|e| {
        let e = e.borrow();
        let Some(eng) = e.as_ref() else { return std::ptr::null() };
        LUCK.with(|l| {
            let mut l = l.borrow_mut();
            let Some(leaves) = l.as_mut() else { return std::ptr::null() };
            LUCK_OUT.with(|out| {
                let mut out = out.borrow_mut();
                out.clear();
                let mut o = 0;
                for _ in 0..count {
                    let n = u16::from_le_bytes([buf[o], buf[o + 1]]) as usize;
                    let g = decode(&buf[o + 2..o + 2 + n]);
                    o += 2 + n;
                    if kind == 0 {
                        leaves.clear();
                        for f in 1..=6u8 {
                            if leaves.len() >= LUCK_MAX {
                                leaves.clear();
                            }
                            out.push(chance_after(&eng.net, &g, f, leaves));
                        }
                    } else {
                        if leaves.len() >= LUCK_MAX {
                            leaves.clear();
                        }
                        out.extend(ludo_sim::search::owner_values_keep(&eng.net, &g, leaves));
                    }
                    LUCK_PEAK.with(|p| {
                        let mut p = p.borrow_mut();
                        *p = (*p).max(leaves.len());
                    });
                }
                out.as_ptr()
            })
        })
    })
}
