//! The direct isThreatened (rules.rs) against the brute-force reference (`Threats::of`: every move of
//! every colour for rolls 1-6, the way rules.ts generates them), on every token of every position of
//! a few thousand games in all ten modes.
use ludo_sim::bot::Policy;
use ludo_sim::dice::roll_face;
use ludo_sim::game::{Game, PHASE_OVER, PHASE_ROLL};
use ludo_sim::rng::Rng;
use ludo_sim::rules::{is_threatened, MoveList, Threats};
use ludo_sim::trace::modes;

#[test]
fn direct_threats_match_reference() {
    let ms = modes();
    let pols = ["random", "easy", "normal", "hard"].map(Policy::parse);
    let mut checked = 0u64;
    for g in 0..2000u64 {
        let (_, seats, singles) = &ms[(g as usize) % ms.len()];
        let mut rng = Rng::seeded(99_000 + g as i64);
        let mut game = Game::new(seats, *singles);
        game.current = (g as usize) % seats.len();
        let mut ml = MoveList::new();
        let mut steps = 0;
        while game.phase != PHASE_OVER && steps < 50000 {
            let th = Threats::of(&game.b, *singles);
            for p in game.b.players() {
                for &t in &p.tokens {
                    assert_eq!(is_threatened(&game.b, p.color, t, *singles), th.get(p.color, t), "game {g} step {steps}");
                    checked += 1;
                }
            }
            if game.phase == PHASE_ROLL {
                let f = roll_face(&game.b, game.current_color(), &mut rng, game.singles, &mut ml);
                game.roll(f);
            } else {
                let o = game.b.p[game.current].owner as usize;
                let k = pols[(g as usize + o) % 4].choose(&game, &mut rng);
                let m = game.moves.m[k];
                game.play(&m);
            }
            steps += 1;
        }
    }
    assert!(checked > 1_000_000, "checked {checked}");
}
