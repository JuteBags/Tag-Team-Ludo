//! game.ts: turn flow (roll the tray, then play it; a 6, a capture or a token home rolls again),
//! game end and rankings. Mutates in place where the TS returns a new state; the visible state after
//! each call is the same.
use crate::rules::{apply_move, classic_moves, is_done, legal_moves, Board, Move, MoveList, BASE, FINISHED};

pub const PHASE_ROLL: u8 = 0;
pub const PHASE_MOVE: u8 = 1;
pub const PHASE_OVER: u8 = 2;
pub const PHASE_NAME: [&str; 3] = ["roll", "move", "over"];
pub const MAX_TRAY: usize = 32;

#[derive(Clone, Copy, Debug)]
pub struct Game {
    pub b: Board,
    pub current: usize,
    pub phase: u8,
    pub rolls: [u8; MAX_TRAY],
    pub nrolls: usize,
    pub sixes: u8,
    pub moves: MoveList,
    /// colours in the order they finished (the last person's colours appended at game end)
    pub ranking: [u8; 4],
    pub nrank: usize,
    pub turn_count: u32,
    pub singles: bool,
    /// Classic one-die Ludo (#148, the AlphaLudo head-to-head; their `ludo_core` rules): each roll is played at
    /// once (no tray), no pairs and no blocking, only a lone token is captured (2+ of a colour on a square are
    /// immune), a 6, a capture or a token home rolls again, three 6s forfeit the turn, and the game ends when the
    /// first player gets all four home. Set with `Game::classic`; `singles` is set too, for the features.
    pub classic: bool,
}

impl Game {
    /// createGame: `seats` = (colour, owner), any order; players end up in colour order.
    pub fn new(seats: &[(u8, u8)], singles: bool) -> Self {
        let b = Board::new(seats);
        Game {
            b,
            current: 0,
            phase: PHASE_ROLL,
            rolls: [0; MAX_TRAY],
            nrolls: 0,
            sixes: 0,
            moves: MoveList::new(),
            ranking: [0; 4],
            nrank: 0,
            turn_count: 0,
            singles,
            classic: false,
        }
    }

    /// A classic one-die game (see `classic`): `seats` as in `new`.
    pub fn classic(seats: &[(u8, u8)]) -> Self {
        let mut g = Game::new(seats, true);
        g.classic = true;
        g
    }

    #[inline]
    pub fn tray(&self) -> &[u8] {
        &self.rolls[..self.nrolls]
    }

    #[inline]
    pub fn current_color(&self) -> u8 {
        self.b.p[self.current].color
    }

    fn next_player(&self) -> usize {
        let n = self.b.n;
        for k in 1..=n {
            let i = (self.current + k) % n;
            if !is_done(&self.b.p[i]) {
                return i;
            }
        }
        self.current
    }

    fn pass_turn(&mut self) {
        self.current = self.next_player();
        self.nrolls = 0;
        self.sixes = 0;
        self.turn_count += 1;
        self.phase = PHASE_ROLL;
        self.moves.clear();
    }

    /// Puts a rolled face in the tray (game.ts roll with `forced`).
    pub fn roll(&mut self, dice: u8) {
        debug_assert!(self.phase == PHASE_ROLL);
        if self.classic {
            return self.classic_roll(dice);
        }
        let color = self.current_color();
        let sixes = if dice == 6 { self.sixes + 1 } else { 0 };
        if sixes == 3 {
            // This run's first two 6s are the last two dice in the tray.
            let kept = self.nrolls - 2;
            tray_moves(&self.b, color, &self.rolls[..kept], self.singles, &mut self.moves);
            if !self.moves.is_empty() {
                self.nrolls = kept;
                self.sixes = 0;
                self.phase = PHASE_MOVE;
            } else {
                self.pass_turn();
            }
            return;
        }
        self.rolls[self.nrolls] = dice;
        self.nrolls += 1;
        if dice == 6 {
            self.sixes = sixes;
            self.moves.clear();
            return;
        }
        tray_moves(&self.b, color, &self.rolls[..self.nrolls], self.singles, &mut self.moves);
        if self.moves.is_empty() {
            self.pass_turn();
            return;
        }
        self.sixes = sixes;
        self.phase = PHASE_MOVE;
    }

    /// Plays `m` (one of self.moves).
    pub fn play(&mut self, m: &Move) {
        debug_assert!(self.phase == PHASE_MOVE);
        if self.classic {
            return self.classic_play(m);
        }
        self.b = apply_move(&self.b, m);
        let cur = self.current;
        let me_done = is_done(&self.b.p[cur]);
        if me_done {
            self.ranking[self.nrank] = self.b.p[cur].color;
            self.nrank += 1;
        }
        // The game ends when only one person still has tokens out; their unfinished colours rank last.
        let mut owner_left = 255u8;
        let mut many = false;
        for p in self.b.players() {
            if is_done(p) {
                continue;
            }
            if owner_left == 255 {
                owner_left = p.owner;
            } else if p.owner != owner_left {
                many = true;
            }
        }
        if !many {
            for i in 0..self.b.n {
                if !is_done(&self.b.p[i]) {
                    self.ranking[self.nrank] = self.b.p[i].color;
                    self.nrank += 1;
                }
            }
            self.phase = PHASE_OVER;
            self.moves.clear();
            return;
        }
        // The move's die leaves the tray.
        if let Some(k) = self.tray().iter().position(|&r| r == m.roll) {
            self.rolls.copy_within(k + 1..self.nrolls, k);
            self.nrolls -= 1;
        }
        let extra = !me_done && (m.ncap > 0 || m.finishes > 0);
        if extra {
            self.phase = PHASE_ROLL;
            self.sixes = 0;
            self.moves.clear();
            return;
        }
        if me_done {
            self.moves.clear();
        } else {
            let color = self.b.p[cur].color;
            tray_moves(&self.b, color, &self.rolls[..self.nrolls], self.singles, &mut self.moves);
        }
        if !self.moves.is_empty() {
            return;
        }
        self.pass_turn();
    }

    /// Classic roll (ludo_core GameState::roll): a third 6 in a row forfeits the turn; no legal move passes it.
    fn classic_roll(&mut self, dice: u8) {
        if dice == 6 {
            self.sixes += 1;
            if self.sixes >= 3 {
                return self.pass_turn();
            }
        } else {
            self.sixes = 0;
        }
        self.moves.clear();
        classic_moves(&self.b, self.current_color(), dice, &mut self.moves);
        if self.moves.is_empty() {
            return self.pass_turn();
        }
        self.rolls[0] = dice;
        self.nrolls = 1;
        self.phase = PHASE_MOVE;
    }

    /// Classic move (ludo_core GameState::apply_move): the first player with all four home wins and ends the
    /// game; a 6, a capture or a token home rolls again (the run of 6s carries on), anything else passes the turn.
    fn classic_play(&mut self, m: &Move) {
        self.b = apply_move(&self.b, m);
        let cur = self.current;
        self.nrolls = 0;
        self.moves.clear();
        if is_done(&self.b.p[cur]) {
            self.ranking[0] = self.b.p[cur].color;
            self.nrank = 1;
            for i in 0..self.b.n {
                if i != cur {
                    self.ranking[self.nrank] = self.b.p[i].color;
                    self.nrank += 1;
                }
            }
            self.phase = PHASE_OVER;
            return;
        }
        if m.roll == 6 || m.ncap > 0 || m.finishes > 0 {
            self.phase = PHASE_ROLL;
        } else {
            self.pass_turn();
        }
    }

    /// People in finishing order (game.ts ownerRanking): done people by their last colour's place, then
    /// everyone else by game.ts unfinishedOrder (#140): more tokens home, then more progress of the tokens not
    /// home, then fewer in base; ties keep first-seen order (turn order; JS sort is stable).
    pub fn owner_ranking(&self) -> Vec<u8> {
        let mut owners: Vec<u8> = Vec::with_capacity(4);
        for p in self.b.players() {
            if !owners.contains(&p.owner) {
                owners.push(p.owner);
            }
        }
        let rank = &self.ranking[..self.nrank];
        let done = |o: u8| self.b.players().iter().filter(|p| p.owner == o).all(is_done);
        let place = |o: u8| {
            self.b
                .players()
                .iter()
                .filter(|p| p.owner == o)
                .map(|p| rank.iter().position(|&c| c == p.color).map(|x| x as i32).unwrap_or(-1))
                .max()
                .unwrap()
        };
        let tokens = |o: u8| self.b.players().iter().filter(move |p| p.owner == o).flat_map(|p| p.tokens.iter().copied());
        let home = |o: u8| tokens(o).filter(|&t| t == FINISHED).count() as i32;
        let board = |o: u8| tokens(o).map(|t| if t == FINISHED { 0 } else { t.max(0) as i32 }).sum::<i32>();
        let base = |o: u8| tokens(o).filter(|&t| t == BASE).count() as i32;
        owners.sort_by(|&a, &b| {
            let d = (done(b) as i32) - (done(a) as i32);
            let k = if d != 0 {
                d
            } else if done(a) {
                place(a) - place(b)
            } else {
                let h = home(b) - home(a);
                let g = board(b) - board(a);
                if h != 0 {
                    h
                } else if g != 0 {
                    g
                } else {
                    base(a) - base(b)
                }
            };
            k.cmp(&0)
        });
        owners
    }
}

/// Legal moves for every distinct die in the tray, biggest die first.
pub fn tray_moves(b: &Board, color: u8, rolls: &[u8], singles: bool, out: &mut MoveList) {
    out.clear();
    for d in (1..=6u8).rev() {
        if rolls.contains(&d) {
            legal_moves(b, color, d, singles, out);
        }
    }
}

