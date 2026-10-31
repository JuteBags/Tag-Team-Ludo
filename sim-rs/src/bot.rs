//! bot.ts: Easy / Normal / Hard move scorers and chooseMove. Scores are summed in the TS source order
//! with the same f64 constants, so ties and the 0.5 jitter resolve identically.
use crate::game::Game;
use crate::rng::Rng;
use crate::rules::{apply_move, is_safe, is_threatened, square_of, Board, Move, FINISHED, HOME_FIRST, KIND_PAIR, KIND_RELEASE, KIND_SINGLE, LAST_TRACK, TRACK_LEN};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Easy,
    Normal,
    Hard,
}

/// isThreatened on one board, each (colour, progress) answered once (rules.ts caches it per board).
pub struct Lazy<'a> {
    b: &'a Board,
    singles: bool,
    /// per colour: bit p known, bit p threatened
    known: [u64; 4],
    val: [u64; 4],
}

impl<'a> Lazy<'a> {
    pub fn new(b: &'a Board, singles: bool) -> Self {
        Lazy { b, singles, known: [0; 4], val: [0; 4] }
    }
    #[inline]
    fn get(&mut self, color: u8, progress: i8) -> bool {
        if progress < 0 {
            return false;
        }
        let c = color as usize;
        let bit = 1u64 << progress;
        if self.known[c] & bit == 0 {
            self.known[c] |= bit;
            if is_threatened(self.b, color, progress, self.singles) {
                self.val[c] |= bit;
            }
        }
        self.val[c] & bit != 0
    }
}

/// Normal (bot.ts scoreMove). `tb`: threats on the board before the move.
pub fn score_move(b: &Board, tb: &mut Lazy, singles: bool, m: &Move) -> f64 {
    let after = apply_move(b, m);
    let mut ta = Lazy::new(&after, singles);
    score_move_with(b, tb, &after, &mut ta, singles, m)
}

fn score_move_with(b: &Board, tb: &mut Lazy, after: &Board, ta: &mut Lazy, singles: bool, m: &Move) -> f64 {
    let on_track = m.to <= LAST_TRACK;
    let to_sq = square_of(m.color, m.to);
    let mut s = 0.0f64;

    for &(c, t) in m.captures() {
        s += (100 + b.of(c).tokens[t as usize] as i32) as f64;
    }
    s += (80 * m.finishes as i32) as f64;
    if m.kind == KIND_RELEASE {
        s += 45.0;
    }
    if m.from < HOME_FIRST && m.to >= HOME_FIRST && m.to < FINISHED {
        s += 50.0;
    }

    let was = m.kind != KIND_RELEASE && tb.get(m.color, m.from);
    let now = on_track && ta.get(m.color, m.to);
    if was && !now {
        s += 60.0;
    }
    if now {
        s -= 50.0 + m.to as f64 * 0.8;
    }

    if to_sq >= 0 && is_safe(to_sq) {
        s += 15.0;
    }
    if to_sq >= 0 && !is_safe(to_sq) && after.count_at(m.color, to_sq) >= 2 {
        s += if singles { -20.0 } else { 35.0 };
    }

    let from_sq = square_of(m.color, m.from);
    if !singles && m.kind == KIND_SINGLE && from_sq >= 0 && !is_safe(from_sq) && b.count_at(m.color, from_sq) >= 2 {
        s -= 25.0;
        if ta.get(m.color, m.from) {
            s -= 30.0;
        }
    }

    s += (m.steps as i32 * m.ntok as i32) as f64 * 0.6;
    s
}

fn score_easy(m: &Move) -> f64 {
    let mut s = 0.0f64;
    for _ in m.captures() {
        s += 100.0;
    }
    s += (80 * m.finishes as i32) as f64;
    if m.kind == KIND_RELEASE {
        s += 45.0;
    }
    s + (m.steps as i32 * m.ntok as i32) as f64 * 0.6
}

fn exposure(b: &Board, th: &mut Lazy, color: u8) -> f64 {
    let mut risk = 0.0f64;
    let mut seen = [false; 64];
    for &t in &b.of(color).tokens {
        if t < 0 || t > LAST_TRACK || seen[t as usize] {
            continue;
        }
        seen[t as usize] = true;
        if th.get(color, t) {
            risk += (20.0 + t as f64 * 1.4) * b.count_at(color, square_of(color, t)) as f64;
        }
    }
    risk
}

fn prey(b: &Board, color: u8, progress: i8, singles: bool) -> f64 {
    let from = square_of(color, progress);
    if from < 0 {
        return 0.0;
    }
    let me = b.owner_of(color);
    let mut value = 0.0f64;
    for p in b.players() {
        if p.owner == me {
            continue;
        }
        for &e in &p.tokens {
            let sq = square_of(p.color, e);
            if sq < 0 || is_safe(sq) || (!singles && b.count_at(p.color, sq) > 1) {
                continue;
            }
            let gap = (sq - from + TRACK_LEN) % TRACK_LEN;
            if (1..=6).contains(&gap) && progress as i32 + gap <= LAST_TRACK as i32 {
                value += 10.0 + e as f64 * 0.3;
            }
        }
    }
    value
}

fn blocks_someone(b: &Board, color: u8, square: i32) -> bool {
    let me = b.owner_of(color);
    b.players().iter().any(|p| {
        p.owner != me
            && p.tokens.iter().any(|&e| {
                let sq = square_of(p.color, e);
                if sq < 0 {
                    return false;
                }
                let gap = (square - sq + TRACK_LEN) % TRACK_LEN;
                (1..=6).contains(&gap)
            })
    })
}

/// `exp_before`: exposure(players, mover) for the board before the move (the same for every move).
fn score_hard(b: &Board, tb: &mut Lazy, exp_before: f64, singles: bool, m: &Move) -> f64 {
    let after = apply_move(b, m);
    let mut ta = Lazy::new(&after, singles);
    let mut s = score_move_with(b, tb, &after, &mut ta, singles, m);
    s -= 0.9 * (exposure(&after, &mut ta, m.color) - exp_before);
    let to_sq = square_of(m.color, m.to);
    if !singles && to_sq >= 0 && !is_safe(to_sq) && after.count_at(m.color, to_sq) >= 2 && m.kind != KIND_PAIR {
        s += if blocks_someone(&after, m.color, to_sq) { 10.0 } else { -55.0 };
    }
    if m.to <= LAST_TRACK && m.kind != KIND_PAIR {
        s += 1.2 * prey(&after, m.color, m.to, singles);
    }
    if m.kind == KIND_RELEASE && b.of(m.color).tokens.iter().filter(|&&t| t >= 0 && t < FINISHED).count() <= 1 {
        s += 20.0;
    }
    s
}

/// bot.ts chooseMove for the current player at `level`; returns an index into g.moves.
pub fn choose_move(g: &Game, level: Level, rng: &mut Rng) -> usize {
    let moves = g.moves.as_slice();
    let n = moves.len();
    if level == Level::Easy && n > 1 && rng.next() < 0.45 {
        return (rng.next() * n as f64).floor() as usize;
    }
    let mut best = usize::MAX;
    let mut best_score = f64::NEG_INFINITY;
    let mut tb = Lazy::new(&g.b, g.singles);
    let exp_before = if level == Level::Hard { exposure(&g.b, &mut tb, moves[0].color) } else { 0.0 };
    for (i, m) in moves.iter().enumerate() {
        let sc = match level {
            Level::Easy => score_easy(m),
            Level::Normal => score_move(&g.b, &mut tb, g.singles, m),
            Level::Hard => score_hard(&g.b, &mut tb, exp_before, g.singles, m),
        };
        let s = sc + rng.next() * 0.5;
        if s > best_score {
            best_score = s;
            best = i;
        }
    }
    assert!(best != usize::MAX, "no legal moves");
    best
}

/// common.ts policy(): random | easy | normal | hard | net:<weights.json>[:depth[:theirK[:temperature[:race[:chance]]]]].
/// The weights file can be a value net or linear rules (eval.rs); both play by search.rs.
#[derive(Clone)]
pub enum Policy {
    Random,
    Bot(Level),
    Search { eval: std::sync::Arc<crate::eval::Evaluator>, opts: crate::search::SearchOptions, temperature: f64 },
}

fn load_eval(path: &str) -> std::sync::Arc<crate::eval::Evaluator> {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<crate::eval::Evaluator>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut c = cache.lock().unwrap();
    c.entry(path.to_string())
        .or_insert_with(|| Arc::new(crate::eval::Evaluator::from_json_text(&std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}")))))
        .clone()
}

impl Policy {
    pub fn parse(s: &str) -> Policy {
        match s {
            "random" => Policy::Random,
            "easy" => Policy::Bot(Level::Easy),
            "normal" => Policy::Bot(Level::Normal),
            "hard" => Policy::Bot(Level::Hard),
            _ if s.starts_with("net:") => {
                // Number(x ?? default): a missing part takes the default
                let parts: Vec<&str> = s.split(':').collect();
                let num = |i: usize, d: f64| parts.get(i).map(|x| x.parse::<f64>().unwrap()).unwrap_or(d);
                let race = parts.get(5) == Some(&"1");
                let opts = crate::search::SearchOptions { depth: num(2, 1.0) as u32, chance: num(6, 2.0) as u32, their_k: num(3, 3.0) as usize, race };
                Policy::Search { eval: load_eval(parts[1]), opts, temperature: num(4, 0.0) }
            }
            _ => panic!("unknown policy {s}"),
        }
    }

    pub fn choose(&self, g: &Game, rng: &mut Rng) -> usize {
        match self {
            Policy::Random => (rng.next() * g.moves.len() as f64).floor() as usize,
            Policy::Bot(l) => choose_move(g, *l, rng),
            Policy::Search { eval, opts, temperature } => crate::search::choose_extreme(eval, g, rng, *opts, *temperature),
        }
    }
}
