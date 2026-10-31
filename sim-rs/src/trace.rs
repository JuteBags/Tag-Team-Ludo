//! tools/ai/common.ts MODES and tools/ai/trace.ts: the same games, step lines, hash and JSON line.
use crate::bot::Policy;
use crate::dice::roll_face;
use crate::game::{Game, PHASE_NAME, PHASE_OVER, PHASE_ROLL};
use crate::rng::Rng;
use crate::rules::{Move, MoveList, COLOR_INITIAL, KIND_INITIAL};
use std::fmt::Write;

/// MODES in key order: (name, seats as (colour, owner), singles). Colours: 0 blue 1 green 2 red 3 yellow.
pub fn modes() -> Vec<(String, Vec<(u8, u8)>, bool)> {
    let mut out = Vec::new();
    for singles in [false, true] {
        let tag = if singles { "-singles" } else { "" };
        // SEATS: 2 = blue, red; 3 = blue, green, red; 4 = all; owner = index in SEATS[n]
        out.push((format!("2p{tag}"), vec![(0, 0), (2, 1)], singles));
        out.push((format!("3p{tag}"), vec![(0, 0), (1, 1), (2, 2)], singles));
        out.push((format!("4p{tag}"), vec![(0, 0), (1, 1), (2, 2), (3, 3)], singles));
        out.push((format!("2h-opposite{tag}"), vec![(0, 0), (1, 1), (2, 0), (3, 1)], singles));
        out.push((format!("2h-side{tag}"), vec![(0, 0), (1, 0), (2, 1), (3, 1)], singles));
    }
    out
}

pub fn state_key(g: &Game, out: &mut String) {
    out.clear();
    write!(out, "{}|{}|", g.current, PHASE_NAME[g.phase as usize]).unwrap();
    for &r in g.tray() {
        out.push((b'0' + r) as char);
    }
    write!(out, "|{}|", g.sixes).unwrap();
    for (i, p) in g.b.players().iter().enumerate() {
        if i > 0 {
            out.push(';');
        }
        for (k, &t) in p.tokens.iter().enumerate() {
            if k > 0 {
                out.push(',');
            }
            write!(out, "{t}").unwrap();
        }
    }
}

pub fn move_key(m: &Move, out: &mut String) {
    out.push(KIND_INITIAL[m.kind as usize]);
    out.push(COLOR_INITIAL[m.color as usize]);
    for &t in m.tokens() {
        out.push((b'0' + t) as char);
    }
    write!(out, ":{}>{}d{}x", m.from, m.to, m.roll).unwrap();
    for &(c, t) in m.captures() {
        out.push(COLOR_INITIAL[c as usize]);
        out.push((b'0' + t) as char);
    }
}

#[inline]
pub fn fnv1a(text: &str, mut h: u32) -> u32 {
    for c in text.bytes() {
        h = (h ^ c as u32).wrapping_mul(0x0100_0193);
    }
    h
}

pub struct GameResult {
    pub steps: u32,
    pub ranking: Vec<u8>,
    pub hash: u32,
    pub trace: Vec<String>,
    pub game: Game,
}

/// One trace.ts game: `hash_steps` builds the step lines (needed for the hash); without it the game
/// is just played (speed runs).
pub fn play_traced(seats: &[(u8, u8)], singles: bool, policies: &[Policy], first: usize, seed: i64, hash_steps: bool, full: bool) -> GameResult {
    let mut rng = Rng::seeded(seed);
    let mut g = Game::new(seats, singles);
    g.current = first;
    let mut ml = MoveList::new();
    let mut h: u32 = 0x811c_9dc5;
    let mut trace = Vec::new();
    let mut line = String::with_capacity(256);
    let mut steps = 0u32;
    while g.phase != PHASE_OVER && steps < 50000 {
        if g.phase == PHASE_ROLL {
            let face = roll_face(&g.b, g.current_color(), &mut rng, g.singles, &mut ml);
            if hash_steps {
                state_key(&g, &mut line);
                write!(line, " R{face}").unwrap();
            }
            g.roll(face);
        } else {
            let owner = g.b.p[g.current].owner as usize;
            let k = policies[owner].choose(&g, &mut rng);
            let m = g.moves.m[k];
            if hash_steps {
                state_key(&g, &mut line);
                line.push_str(" M");
                move_key(&m, &mut line);
                line.push('/');
                for (i, x) in g.moves.as_slice().iter().enumerate() {
                    if i > 0 {
                        line.push(',');
                    }
                    move_key(x, &mut line);
                }
            }
            g.play(&m);
        }
        if hash_steps {
            line.push('\n');
            h = fnv1a(&line, h);
            if full {
                line.pop();
                trace.push(line.clone());
            }
        }
        steps += 1;
    }
    let ranking = g.owner_ranking();
    if hash_steps {
        state_key(&g, &mut line);
        line.push_str(" END");
        for &o in &ranking {
            line.push((b'0' + o) as char);
        }
        line.push('\n');
        h = fnv1a(&line, h);
        if full {
            line.pop();
            trace.push(line.clone());
        }
    }
    GameResult { steps, ranking, hash: h, trace, game: g }
}

/// The JSON line trace.ts writes for game `g` (same key order, no spaces).
pub fn json_line(g: u64, seed: i64, mode: &str, first: usize, policies: &[&str], r: &GameResult, full: bool) -> String {
    let mut s = String::with_capacity(160);
    write!(s, "{{\"g\":{g},\"seed\":{seed},\"mode\":\"{mode}\",\"first\":{first},\"policies\":[").unwrap();
    for (i, p) in policies.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        write!(s, "\"{p}\"").unwrap();
    }
    write!(s, "],\"steps\":{},\"ranking\":[", r.steps).unwrap();
    for (i, o) in r.ranking.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        write!(s, "{o}").unwrap();
    }
    write!(s, "],\"hash\":\"{:08x}\"", r.hash).unwrap();
    if full {
        s.push_str(",\"trace\":[");
        for (i, l) in r.trace.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            write!(s, "\"{l}\"").unwrap();
        }
        s.push(']');
    }
    s.push('}');
    s
}
