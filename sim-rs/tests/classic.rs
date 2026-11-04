//! The classic one-die mode (#148, AlphaLudo's `ludo_core` rules), rule by rule. The lockstep parity check
//! against their engine itself runs on CI (tools/ai/h2h).
use ludo_sim::game::{Game, PHASE_MOVE, PHASE_OVER, PHASE_ROLL};
use ludo_sim::rules::{BASE, FINISHED};

/// Their seat p is our colour (p + 1) % 4 (seat 0 starts on our green's square 0); owner = seat.
const SEATS_4P: [(u8, u8); 4] = [(1, 0), (2, 1), (3, 2), (0, 3)];
const G: u8 = 1; // green: track square = progress
const R: u8 = 2; // red: square = progress + 13

fn game() -> Game {
    let mut g = Game::classic(&SEATS_4P);
    g.current = g.b.idx[G as usize] as usize;
    g
}
fn set(g: &mut Game, color: u8, tokens: [i8; 4]) {
    g.b.of_mut(color).tokens = tokens;
}

#[test]
fn a_non_six_with_everyone_in_base_passes_and_a_six_brings_one_out() {
    let mut g = game();
    g.roll(3);
    assert_eq!((g.phase, g.current_color()), (PHASE_ROLL, R), "no move: the turn passes");
    let mut g = game();
    g.roll(6);
    assert_eq!(g.phase, PHASE_MOVE);
    assert!(g.moves.as_slice().iter().all(|m| m.from == BASE && m.to == 0));
    let m = g.moves.m[0];
    g.play(&m);
    assert_eq!((g.phase, g.current_color()), (PHASE_ROLL, G), "a 6 rolls again");
    assert_eq!(g.tray().len(), 0, "no tray: each roll is played at once");
}

#[test]
fn only_a_lone_token_is_captured_and_stacks_do_not_block() {
    // Green at 10 (square 10); red progress p sits on square p + 13.
    let mut g = game();
    set(&mut g, G, [10, BASE, BASE, BASE]);
    set(&mut g, R, [2, BASE, BASE, BASE]); // red progress 2 = square 15 = green progress 15
    g.roll(5);
    let m = g.moves.m[0];
    assert_eq!((m.to, m.ncap), (15, 1), "a lone red token on a normal square is captured");
    g.play(&m);
    assert_eq!(g.b.of(R).tokens[0], BASE);
    assert_eq!(g.current_color(), G, "a capture rolls again");

    let mut g = game();
    set(&mut g, G, [10, BASE, BASE, BASE]);
    set(&mut g, R, [2, 2, BASE, BASE]); // two red tokens on square 15
    g.roll(5);
    assert_eq!(g.moves.m[0].ncap, 0, "2+ of a colour are immune");
    let mut g = game();
    set(&mut g, G, [10, BASE, BASE, BASE]);
    set(&mut g, R, [2, 2, BASE, BASE]);
    g.roll(6);
    assert!(g.moves.as_slice().iter().any(|m| m.from == 10 && m.to == 16), "a single passes an enemy stack");
}

#[test]
fn safe_squares_and_the_exact_finish() {
    let mut g = game();
    set(&mut g, R, [34, BASE, BASE, BASE]); // red progress 34 = square 47, a star
    set(&mut g, G, [43, BASE, BASE, BASE]);
    g.roll(4);
    assert_eq!((g.moves.m[0].to, g.moves.m[0].ncap), (47, 0), "no capture on a star");

    let mut g = game();
    set(&mut g, G, [53, FINISHED, FINISHED, FINISHED]);
    g.roll(4);
    assert_eq!(g.phase, PHASE_ROLL, "53 + 4 passes 56: no move, the turn passes");
    assert_eq!(g.current_color(), R);
}

#[test]
fn three_sixes_forfeit_and_a_six_without_a_move_ends_the_turn() {
    let mut g = game();
    set(&mut g, G, [10, BASE, BASE, BASE]);
    g.roll(6);
    let m = g.moves.as_slice().iter().find(|m| m.from == 10).copied().unwrap();
    g.play(&m);
    g.roll(6);
    let m = g.moves.as_slice().iter().find(|m| m.from == 16).copied().unwrap();
    g.play(&m);
    assert_eq!((g.current_color(), g.b.of(G).tokens[0]), (G, 22), "two 6s played at once");
    g.roll(6);
    assert_eq!((g.phase, g.current_color(), g.b.of(G).tokens[0]), (PHASE_ROLL, R, 22), "the third 6 forfeits; the moves stand");

    let mut g = game();
    set(&mut g, G, [53, FINISHED, FINISHED, FINISHED]);
    g.roll(6);
    assert_eq!(g.current_color(), R, "a 6 with no move passes the turn");
    assert_eq!(g.sixes, 0);
}

#[test]
fn the_first_player_home_wins_and_ends_the_game() {
    let mut g = game();
    set(&mut g, G, [54, FINISHED, FINISHED, FINISHED]);
    g.roll(2);
    let m = g.moves.m[0];
    assert_eq!(m.finishes, 1);
    g.play(&m);
    assert_eq!(g.phase, PHASE_OVER);
    assert_eq!(g.owner_ranking()[0], 0, "seat 0 (green) wins");
}

#[test]
fn a_token_home_rolls_again() {
    let mut g = game();
    set(&mut g, G, [54, 10, BASE, BASE]);
    g.roll(2);
    let m = g.moves.as_slice().iter().find(|m| m.from == 54).copied().unwrap();
    g.play(&m);
    assert_eq!((g.phase, g.current_color()), (PHASE_ROLL, G));
}
