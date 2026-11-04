//! Head-to-head harness (#148): Tag Team Ludo's Extreme against AlphaLudo V17, in AlphaLudo's classic rules.
//!
//!   h2h parity --games 10000 [--from 1]
//!       Random games stepped in lockstep in their engine (ludo_core, the referee) and in our classic mode
//!       (sim-rs `Game::classic`): after every roll, the same set of next states for every legal move (positions,
//!       whose turn, the run of 6s, the end and the winner), and the same state after the move played. Exits 1 at
//!       the first difference, printing it.
//!   h2h match --layout 2p|4p --a <player> --b <player> --games N --from D --out results.jsonl
//!             [--to-end 0|1] [--net extreme-net.json --playout playout-rules.json] [--v17 "<command>"]
//!       Games refereed by their engine with fair dice: one dice stream per seat, seeded by the deal, so a deal is
//!       played with each side in each seat over the same dice (2p: 2 games per deal, A at seat 0 then seat 2;
//!       4p: 4 games per deal, the lone A at seat 0, 1, 2, 3 and B in the other three). Players:
//!         extreme-net    our Extreme: choose_race, 128 playouts (--nmax), Hard-rule playouts, our net at the 12-turn cut
//!         extreme-rules  the same with rule-only playouts to the game's end (no net)
//!         v17            AlphaLudo V17 as shipped: one forward pass, argmax over the legal cells (no search),
//!                        run by the --v17 command (v17.py), which answers one request per line pair on stdio
//!       --to-end 1 plays on after the first player is home (that seat leaves; the rest play for the next place)
//!       until one is left; 0 (default) stops where their rules end the game, at the first player home.
//!       One JSON line per game.
use ludo_core::{encode_unified_into, uni_action_cell, uni_legal_mask_into, GameState, NUM_BOARD_CELLS, UNI_FRAME_SIZE};
use ludo_sim::bot::Policy;
use ludo_sim::eval::Evaluator;
use ludo_sim::game::{Game, PHASE_MOVE, PHASE_OVER};
use ludo_sim::rng::Rng;
use ludo_sim::rules::{BASE, FINISHED};
use ludo_sim::search::SearchOptions;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Arc;
use std::time::Instant;

const HOME: i8 = 99; // ludo_core HOME_POS
/// Extreme's playouts per candidate (the app's Extreme: 128); `--nmax` changes it for both sides' Extreme.
const NMAX: usize = 128;
const CUT: u32 = 12;

/// Their seat p is our colour (p + 1) % 4: seat 0 starts on track square 0, our green's start.
fn colour(seat: usize) -> u8 {
    ((seat + 1) % 4) as u8
}
fn seat_of(colour: u8) -> usize {
    (colour as usize + 3) % 4
}

fn face(r: &mut Rng) -> u8 {
    ((r.next() * 6.0) as u8).min(5) + 1
}

/// Our classic Game for their state, in the roll phase (their state before `roll`). Inactive seats are left out.
fn ours_roll_phase(st: &GameState) -> Game {
    let seats: Vec<(u8, u8)> = (0..4).filter(|&s| st.active_players[s]).map(|s| (colour(s), s as u8)).collect();
    let mut g = Game::classic(&seats);
    for s in 0..4 {
        if !st.active_players[s] {
            continue;
        }
        let mut t = [BASE; 4];
        for k in 0..4 {
            let p = st.positions[s][k];
            t[k] = if p == HOME { FINISHED } else { p };
        }
        g.b.of_mut(colour(s)).tokens = t;
    }
    g.current = g.b.idx[colour(st.current_player as usize) as usize] as usize;
    g.sixes = st.consecutive_sixes[st.current_player as usize];
    g
}

/// Our classic Game at their decision (dice rolled, a legal move to choose): the same state, then the same roll.
fn ours_at_decision(st: &GameState) -> Game {
    let mut before = *st;
    let d = st.current_dice_roll;
    if d == 6 {
        before.consecutive_sixes[st.current_player as usize] -= 1;
    }
    before.current_dice_roll = 0;
    let mut g = ours_roll_phase(&before);
    g.roll(d);
    assert_eq!(g.phase, PHASE_MOVE, "their engine has a move to choose, ours must too");
    g
}

/// Their token for our move (tokens of a colour on one square are interchangeable).
fn token_for(st: &GameState, from: i8) -> u8 {
    let p = st.current_player as usize;
    let (legal, n) = st.legal_moves();
    *legal[..n].iter().find(|&&t| st.positions[p][t as usize] == from).expect("our move is one of theirs")
}

/// A canonical state for comparing the two engines: per seat the sorted positions (99 = home), whose turn, the
/// current run of 6s, over, winner.
type Canon = ([[i8; 4]; 4], u8, u8, bool, i8);
fn canon_theirs(st: &GameState) -> Canon {
    let mut pos = [[i8::MIN; 4]; 4];
    for s in 0..4 {
        if st.active_players[s] {
            pos[s] = st.positions[s];
            pos[s].sort_unstable();
        }
    }
    let over = st.is_terminal;
    let cur = if over { 255 } else { st.current_player };
    let six = if over { 0 } else { st.consecutive_sixes[st.current_player as usize] };
    (pos, cur, six, over, if over { st.winner } else { -1 })
}
fn canon_ours(g: &Game) -> Canon {
    let mut pos = [[i8::MIN; 4]; 4];
    for p in g.b.players() {
        let s = seat_of(p.color);
        let mut t = p.tokens.map(|x| if x == FINISHED { HOME } else { x });
        t.sort_unstable();
        pos[s] = t;
    }
    let over = g.phase == PHASE_OVER;
    let cur = if over { 255 } else { seat_of(g.current_color()) as u8 };
    (pos, cur, if over { 0 } else { g.sixes }, over, if over { g.owner_ranking()[0] as i8 } else { -1 })
}

fn arg(f: &HashMap<String, String>, k: &str, d: &str) -> String {
    f.get(k).cloned().unwrap_or_else(|| d.to_string())
}

fn fail(seed: i64, four: bool, what: &str, st: &GameState, g: &Game, extra: String) -> ! {
    eprintln!("PARITY MISMATCH game {seed} ({}): {what}\n  theirs: {:?}\n  ours:   {:?}\n  {extra}", if four { "4p" } else { "2p" }, canon_theirs(st), canon_ours(g));
    std::process::exit(1);
}

fn parity(f: &HashMap<String, String>) {
    let games: i64 = arg(f, "games", "10000").parse().unwrap();
    let from: i64 = arg(f, "from", "1").parse().unwrap();
    let t0 = Instant::now();
    let (mut steps, mut decisions, mut moves_checked) = (0u64, 0u64, 0u64);
    for gi in 0..games {
        let seed = from + gi;
        let four = gi % 2 == 0;
        let mut st = if four { GameState::new_4p() } else { GameState::new_2p() };
        let mut rng = Rng::seeded(seed * 7919 + 13);
        let active: Vec<u8> = (0..4u8).filter(|&s| st.active_players[s as usize]).collect();
        st.current_player = active[(seed as usize) % active.len()];
        let mut g = ours_roll_phase(&st);
        let mut n = 0;
        while !st.is_terminal {
            n += 1;
            if n > 20000 {
                fail(seed, four, "no end after 20000 rolls", &st, &g, String::new());
            }
            let d = face(&mut rng);
            let before = st;
            let has = st.roll(d);
            g.roll(d);
            steps += 1;
            if !has {
                if g.phase == PHASE_MOVE || canon_theirs(&st) != canon_ours(&g) {
                    fail(seed, four, &format!("after rolling {d} with no move"), &st, &g, format!("before: {:?}", canon_theirs(&before)));
                }
                continue;
            }
            if g.phase != PHASE_MOVE {
                fail(seed, four, &format!("they have a move after {d}, we don't"), &st, &g, String::new());
            }
            decisions += 1;
            let (legal, cnt) = st.legal_moves();
            let mut a: Vec<Canon> = legal[..cnt].iter().map(|&t| canon_theirs(&st.apply_move(t))).collect();
            let mut b: Vec<Canon> = g.moves.as_slice().iter().map(|m| {
                let mut h = g;
                h.play(m);
                canon_ours(&h)
            }).collect();
            a.sort();
            a.dedup();
            b.sort();
            b.dedup();
            moves_checked += cnt as u64;
            if a != b {
                fail(seed, four, &format!("next states differ after rolling {d}"), &st, &g, format!("theirs {a:?}\n  ours   {b:?}"));
            }
            let t = legal[(rng.next() * cnt as f64) as usize % cnt];
            let from_pos = st.positions[st.current_player as usize][t as usize];
            let m = *g.moves.as_slice().iter().find(|m| m.from == from_pos).unwrap();
            st = st.apply_move(t);
            g.play(&m);
            if canon_theirs(&st) != canon_ours(&g) {
                fail(seed, four, "after the move played", &st, &g, String::new());
            }
        }
    }
    println!("PARITY OK: {games} games (2p and 4p), {steps} rolls, {decisions} decisions, {moves_checked} legal moves compared, {:.1} s", t0.elapsed().as_secs_f64());
}

/// The V17 child process (v17.py): a request is one line with the frame (1125 int8) and the mask (225 0/1) as
/// space-separated numbers; the answer is one line with the chosen cell.
struct V17 {
    _child: Child,
    inp: ChildStdin,
    out: BufReader<ChildStdout>,
}
impl V17 {
    fn start(cmd: &str) -> Self {
        let mut child = Command::new("bash").arg("-c").arg(cmd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().expect("start v17");
        let inp = child.stdin.take().unwrap();
        let out = BufReader::new(child.stdout.take().unwrap());
        V17 { _child: child, inp, out }
    }
    fn choose(&mut self, st: &GameState) -> u8 {
        let mut x = vec![0i8; UNI_FRAME_SIZE];
        let mut mask = vec![0f32; NUM_BOARD_CELLS];
        encode_unified_into(st, st.current_player, &mut x);
        uni_legal_mask_into(st, &mut mask);
        let mut line = String::with_capacity(4 * UNI_FRAME_SIZE);
        for v in &x {
            line.push_str(&v.to_string());
            line.push(' ');
        }
        line.push('|');
        for v in &mask {
            line.push(if *v > 0.0 { '1' } else { '0' });
        }
        line.push('\n');
        self.inp.write_all(line.as_bytes()).unwrap();
        self.inp.flush().unwrap();
        let mut ans = String::new();
        self.out.read_line(&mut ans).unwrap();
        let cell: usize = ans.trim().parse().expect("v17 answer");
        let (legal, n) = st.legal_moves();
        *legal[..n].iter().find(|&&t| uni_action_cell(st, t) == cell).expect("v17 chose a legal cell")
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    ExtremeNet,
    ExtremeRules,
    V17,
}
fn kind(s: &str) -> Kind {
    match s {
        "extreme-net" => Kind::ExtremeNet,
        "extreme-rules" => Kind::ExtremeRules,
        "v17" => Kind::V17,
        _ => panic!("unknown player {s}"),
    }
}

fn matches(f: &HashMap<String, String>) {
    let layout = arg(f, "layout", "2p");
    let four = layout == "4p";
    let a = kind(&arg(f, "a", "extreme-net"));
    let b = kind(&arg(f, "b", "v17"));
    let games: i64 = arg(f, "games", "2").parse().unwrap();
    let from: i64 = arg(f, "from", "0").parse().unwrap();
    let to_end = arg(f, "to-end", "0") == "1";
    let nmax: usize = arg(f, "nmax", &NMAX.to_string()).parse().unwrap();
    let out_path = arg(f, "out", "h2h.jsonl");
    let needs_v17 = a == Kind::V17 || b == Kind::V17;
    let needs_ours = a != Kind::V17 || b != Kind::V17;
    let (net, base) = if needs_ours {
        let net = Evaluator::from_json_text(&std::fs::read_to_string(arg(f, "net", "extreme-net.json")).unwrap());
        let playout = Arc::new(Evaluator::from_json_text(&std::fs::read_to_string(arg(f, "playout", "playout-rules.json")).unwrap()));
        // sim-wasm's base, as ludo-brilliant: Hard-style search over the playout rules (depth 1, chance 1, their_k 3).
        let base = Policy::Search { eval: playout, opts: SearchOptions { depth: 1, chance: 1, their_k: 3, race: false, cut: 0.0 }, temperature: 0.0 };
        (Some(net), Some(base))
    } else {
        (None, None)
    };
    let mut v17 = if needs_v17 { Some(V17::start(&arg(f, "v17", "python3 v17.py model.onnx"))) } else { None };
    let rot = if four { 4 } else { 2 };
    let mut out = std::fs::File::create(&out_path).unwrap();
    let t_all = Instant::now();
    for gi in 0..games {
        let game_no = from * rot + gi; // shards pass --from in deals
        let deal = game_no / rot;
        let r = (game_no % rot) as usize;
        let mut st = if four { GameState::new_4p() } else { GameState::new_2p() };
        let active: Vec<usize> = (0..4).filter(|&s| st.active_players[s]).collect();
        // Who sits where: A at one seat (2p: seat 0 or 2; 4p: seat r), B at the others.
        let a_seat = active[r];
        let who: Vec<(usize, Kind)> = active.iter().map(|&s| (s, if s == a_seat { a } else { b })).collect();
        let kind_at = |s: usize| who.iter().find(|w| w.0 == s).unwrap().1;
        let mut dice: Vec<Rng> = (0..4).map(|s| Rng::seeded(deal * 1_000_003 + s as i64 * 7919 + 17)).collect();
        let mut places: Vec<usize> = Vec::new();
        let (mut rolls, mut dec, mut ms) = (0u64, [0u64; 2], [0f64; 2]); // [A, B]
        let t_game = Instant::now();
        let mut cut_short = false;
        loop {
            if st.is_terminal {
                places.push(st.winner as usize);
                let left = (0..4).filter(|&s| st.active_players[s] && !places.contains(&s)).count();
                if !to_end || left <= 1 {
                    break;
                }
                // Play on for the next place: the seat home leaves (their engine skips inactive seats).
                let w = st.winner as usize;
                st.active_players[w] = false;
                st.is_terminal = false;
                st.winner = -1;
                st.consecutive_sixes[w] = 0;
                st.current_player = st.next_player();
                st.current_dice_roll = 0;
            }
            rolls += 1;
            if rolls > 200_000 {
                cut_short = true;
                break;
            }
            let seat = st.current_player as usize;
            let d = face(&mut dice[seat]);
            if !st.roll(d) {
                continue;
            }
            let (legal, n) = st.legal_moves();
            let side = if seat == a_seat { 0 } else { 1 };
            let t = if n == 1 {
                legal[0]
            } else {
                let t0 = Instant::now();
                let tok = match kind_at(seat) {
                    Kind::V17 => v17.as_mut().unwrap().choose(&st),
                    k => {
                        let g = ours_at_decision(&st);
                        let mut rng = Rng::seeded(game_no * 1_000_003 + rolls as i64 * 7919 + 1);
                        let eval = if k == Kind::ExtremeNet { net.as_ref() } else { None };
                        let i = ludo_sim::rollout::choose_race(&g, &mut rng, nmax, CUT, eval, base.as_ref().unwrap(), base.as_ref().unwrap());
                        token_for(&st, g.moves.m[i].from)
                    }
                };
                ms[side] += t0.elapsed().as_secs_f64() * 1000.0;
                dec[side] += 1;
                tok
            };
            st = st.apply_move(t);
        }
        let name = |k: Kind| match k {
            Kind::ExtremeNet => "extreme-net",
            Kind::ExtremeRules => "extreme-rules",
            Kind::V17 => "v17",
        };
        let winner = places.first().copied();
        let line = format!(
            "{{\"layout\":\"{layout}\",\"a\":\"{}\",\"b\":\"{}\",\"deal\":{deal},\"rot\":{r},\"a_seat\":{a_seat},\"winner_seat\":{},\"a_won\":{},\"places\":[{}],\"to_end\":{to_end},\"nmax\":{nmax},\"rolls\":{rolls},\"cut_short\":{cut_short},\"dec\":[{},{}],\"ms\":[{:.1},{:.1}],\"game_s\":{:.2}}}",
            name(a), name(b),
            winner.map_or(-1, |w| w as i64),
            winner == Some(a_seat),
            places.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(","),
            dec[0], dec[1], ms[0], ms[1],
            t_game.elapsed().as_secs_f64()
        );
        writeln!(out, "{line}").unwrap();
        out.flush().unwrap();
        if gi % 5 == 4 || gi + 1 == games {
            eprintln!("{} / {games} games, {:.0} s", gi + 1, t_all.elapsed().as_secs_f64());
        }
    }
    println!("H2H {layout} a={} b={} games {games} from deal {from}: done in {:.0} s", arg(f, "a", ""), arg(f, "b", ""), t_all.elapsed().as_secs_f64());
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut f = HashMap::new();
    let mut i = 2;
    while i + 1 < args.len() {
        f.insert(args[i].trim_start_matches("--").to_string(), args[i + 1].clone());
        i += 2;
    }
    match args.get(1).map(|s| s.as_str()) {
        Some("parity") => parity(&f),
        Some("match") => matches(&f),
        _ => {
            let mut s = String::new();
            let _ = std::io::stdin().read_to_string(&mut s);
            eprintln!("usage: h2h parity|match ... (see the top of main.rs)");
            std::process::exit(2);
        }
    }
}
