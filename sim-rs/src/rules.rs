//! board.ts + rules.ts: geometry, move generation, captures, blocks and threats.
//!
//! The TS caches (blockers, legalMoves, isThreatened per board) only memoise pure functions, so they
//! are left out: the answers are the same, recomputed.

pub const BASE: i8 = -1;
pub const LAST_TRACK: i8 = 50;
pub const HOME_FIRST: i8 = 51;
pub const FINISHED: i8 = 56;
pub const TRACK_LEN: i32 = 52;

/// Colour indices follow board.ts COLORS: blue, green, red, yellow.
pub const COLOR_INITIAL: [char; 4] = ['b', 'g', 'r', 'y'];
/// Absolute track index of each colour's start square (board.ts START).
pub const START: [i32; 4] = [39, 0, 13, 26];
/// SAFE_SQUARES as a bit mask over the 52 track squares.
const SAFE_MASK: u64 = (1 << 0) | (1 << 8) | (1 << 13) | (1 << 21) | (1 << 26) | (1 << 34) | (1 << 39) | (1 << 47);

#[inline]
pub fn is_safe(sq: i32) -> bool {
    (SAFE_MASK >> sq) & 1 == 1
}

/// Absolute track square for a token, or -1 when it is in base, the home column or finished.
#[inline]
pub fn square_of(color: u8, progress: i8) -> i32 {
    if progress < 0 || progress > LAST_TRACK {
        return -1;
    }
    (START[color as usize] + progress as i32) % TRACK_LEN
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Player {
    pub color: u8,
    pub owner: u8,
    pub tokens: [i8; 4],
}

/// The players array of a GameState: kept in COLORS order, with a colour -> index lookup.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Board {
    pub n: usize,
    pub p: [Player; 4],
    pub idx: [u8; 4],
}

impl Board {
    /// `players` sorted by colour like createGame does.
    pub fn new(seats: &[(u8, u8)]) -> Self {
        let mut s: Vec<(u8, u8)> = seats.to_vec();
        s.sort_by_key(|x| x.0);
        let mut p = [Player { color: 0, owner: 0, tokens: [BASE; 4] }; 4];
        let mut idx = [255u8; 4];
        for (i, &(color, owner)) in s.iter().enumerate() {
            p[i] = Player { color, owner, tokens: [BASE; 4] };
            idx[color as usize] = i as u8;
        }
        Board { n: s.len(), p, idx }
    }

    #[inline]
    pub fn of(&self, color: u8) -> &Player {
        &self.p[self.idx[color as usize] as usize]
    }

    #[inline]
    pub fn of_mut(&mut self, color: u8) -> &mut Player {
        let i = self.idx[color as usize] as usize;
        &mut self.p[i]
    }

    #[inline]
    pub fn players(&self) -> &[Player] {
        &self.p[..self.n]
    }

    /// How many of `color`'s tokens stand on an absolute track square (rules.ts countAt).
    #[inline]
    pub fn count_at(&self, color: u8, square: i32) -> i32 {
        if self.idx[color as usize] == 255 {
            return 0;
        }
        self.of(color).tokens.iter().filter(|&&t| square_of(color, t) == square).count() as i32
    }

    #[inline]
    pub fn owner_of(&self, color: u8) -> u8 {
        self.of(color).owner
    }
}

#[inline]
pub fn is_done(p: &Player) -> bool {
    p.tokens.iter().all(|&t| t == FINISHED)
}

pub const KIND_RELEASE: u8 = 0;
pub const KIND_SINGLE: u8 = 1;
pub const KIND_PAIR: u8 = 2;
pub const KIND_INITIAL: [char; 3] = ['r', 's', 'p'];
/// singles mode can capture every enemy token on a square: 4 per enemy colour, 3 enemy colours.
pub const MAX_CAPS: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Move {
    pub kind: u8,
    pub color: u8,
    pub ntok: u8,
    pub tok: [u8; 2],
    pub from: i8,
    pub to: i8,
    pub steps: i8,
    pub roll: u8,
    pub ncap: u8,
    /// (colour, token index)
    pub caps: [(u8, u8); MAX_CAPS],
    pub finishes: u8,
}

impl Move {
    #[inline]
    pub fn tokens(&self) -> &[u8] {
        &self.tok[..self.ntok as usize]
    }
    #[inline]
    pub fn captures(&self) -> &[(u8, u8)] {
        &self.caps[..self.ncap as usize]
    }
}

/// tray dice are distinct faces, at most 10 moves each (4 releases or singles, 2 pairs).
pub const MAX_MOVES: usize = 64;

#[derive(Clone, Copy, Debug)]
pub struct MoveList {
    pub n: usize,
    pub m: [Move; MAX_MOVES],
}

impl MoveList {
    pub fn new() -> Self {
        MoveList { n: 0, m: [EMPTY_MOVE; MAX_MOVES] }
    }
    #[inline]
    pub fn clear(&mut self) {
        self.n = 0;
    }
    #[inline]
    pub fn push(&mut self, m: Move) {
        self.m[self.n] = m;
        self.n += 1;
    }
    #[inline]
    pub fn as_slice(&self) -> &[Move] {
        &self.m[..self.n]
    }
    #[inline]
    pub fn len(&self) -> usize {
        self.n
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.n == 0
    }
}

impl Default for MoveList {
    fn default() -> Self {
        Self::new()
    }
}

pub const EMPTY_MOVE: Move =
    Move { kind: 0, color: 0, ntok: 0, tok: [0; 2], from: 0, to: 0, steps: 0, roll: 0, ncap: 0, caps: [(0, 0); MAX_CAPS], finishes: 0 };

/// True when an enemy of `mover` (another person) has a double (2+ tokens) on a non-star square.
#[inline]
pub fn is_blocked_for(b: &Board, square: i32, mover: u8, singles: bool) -> bool {
    if singles || is_safe(square) {
        return false;
    }
    let me = b.owner_of(mover);
    b.players().iter().any(|p| p.owner != me && p.tokens.iter().filter(|&&t| square_of(p.color, t) == square).count() >= 2)
}

#[inline]
fn is_locked(b: &Board, color: u8, progress: i8, singles: bool) -> bool {
    if singles {
        return false;
    }
    let sq = square_of(color, progress);
    sq >= 0 && !is_safe(sq) && b.count_at(color, sq) % 2 == 0
}

/// rules.ts walk: Some((to, captures)) or None if it overshoots or a single would pass an enemy double.
fn walk(b: &Board, color: u8, from: i8, steps: i8, pair: bool, singles: bool, mv: &mut Move) -> bool {
    if from == BASE {
        return false;
    }
    let to = from + steps;
    if to > FINISHED {
        return false;
    }
    if !pair {
        for p in (from + 1)..to {
            let sq = square_of(color, p);
            if sq >= 0 && is_blocked_for(b, sq, color, singles) {
                return false;
            }
        }
    }
    mv.to = to;
    mv.ncap = 0;
    let sq = square_of(color, to);
    if sq >= 0 && !is_safe(sq) {
        let me = b.owner_of(color);
        for p in b.players() {
            if p.owner == me {
                continue;
            }
            let mut here = [0u8; 4];
            let mut nh = 0usize;
            for (i, &t) in p.tokens.iter().enumerate() {
                if square_of(p.color, t) == sq {
                    here[nh] = i as u8;
                    nh += 1;
                }
            }
            if singles {
                for &i in &here[..nh] {
                    mv.caps[mv.ncap as usize] = (p.color, i);
                    mv.ncap += 1;
                }
            } else if pair {
                if nh >= 2 {
                    for &i in &here[..2] {
                        mv.caps[mv.ncap as usize] = (p.color, i);
                        mv.ncap += 1;
                    }
                }
            } else if nh % 2 == 1 {
                mv.caps[mv.ncap as usize] = (p.color, here[nh - 1]);
                mv.ncap += 1;
            }
        }
    }
    true
}

/// rules.ts legalMoves / computeMoves, appended to `out` in the engine's order.
pub fn legal_moves(b: &Board, color: u8, roll: u8, singles: bool, out: &mut MoveList) {
    let me = *b.of(color);
    let r = roll as i8;
    if roll == 6 {
        for (i, &t) in me.tokens.iter().enumerate() {
            if t == BASE {
                out.push(Move { kind: KIND_RELEASE, color, ntok: 1, tok: [i as u8, 0], from: BASE, to: 0, steps: 0, roll, ..EMPTY_MOVE });
            }
        }
    }
    let mut seen = [false; 64];
    for (i, &t) in me.tokens.iter().enumerate() {
        if t == BASE || t == FINISHED || seen[t as usize] {
            continue;
        }
        seen[t as usize] = true;
        if is_locked(b, color, t, singles) {
            continue;
        }
        let mut mv = Move { kind: KIND_SINGLE, color, ntok: 1, tok: [i as u8, 0], from: t, steps: r, roll, ..EMPTY_MOVE };
        if walk(b, color, t, r, false, singles, &mut mv) {
            mv.finishes = (mv.to == FINISHED) as u8;
            out.push(mv);
        }
    }
    if roll % 2 == 0 && !singles {
        let half = r / 2;
        // groups by progress, in order of first appearance (a JS Map's insertion order)
        let mut gt = [0i8; 4];
        let mut gi = [[0u8; 4]; 4];
        let mut gn = [0usize; 4];
        let mut ng = 0usize;
        for (i, &t) in me.tokens.iter().enumerate() {
            if t < 0 || t > LAST_TRACK {
                continue;
            }
            match (0..ng).find(|&k| gt[k] == t) {
                Some(k) => {
                    gi[k][gn[k]] = i as u8;
                    gn[k] += 1;
                }
                None => {
                    gt[ng] = t;
                    gi[ng][0] = i as u8;
                    gn[ng] = 1;
                    ng += 1;
                }
            }
        }
        for k in 0..ng {
            if gn[k] < 2 {
                continue;
            }
            let t = gt[k];
            let mut mv = Move { kind: KIND_PAIR, color, ntok: 2, tok: [gi[k][0], gi[k][1]], from: t, steps: half, roll, ..EMPTY_MOVE };
            if walk(b, color, t, half, true, false, &mut mv) {
                mv.finishes = if mv.to == FINISHED { 2 } else { 0 };
                out.push(mv);
            }
        }
    }
}

pub fn apply_move(b: &Board, m: &Move) -> Board {
    let mut next = *b;
    {
        let me = next.of_mut(m.color);
        for &i in m.tokens() {
            me.tokens[i as usize] = m.to;
        }
    }
    for &(c, t) in m.captures() {
        next.of_mut(c).tokens[t as usize] = BASE;
    }
    next
}

/// Could some enemy capture `color`'s token(s) at `progress` with a single roll of 1-6?
///
/// rules.ts asks each enemy only about the rolls that reach the square; every capturing move lands on
/// the captured token's square, so asking about all six rolls finds exactly the same captures. One
/// pass over every colour's moves for 1-6 answers all (colour, progress) questions for a board:
/// `Threats` holds that, a bit per (colour, progress).
#[derive(Clone, Copy, Debug)]
pub struct Threats {
    bits: [u64; 4],
}

impl Threats {
    pub fn of(b: &Board, singles: bool) -> Self {
        let mut bits = [0u64; 4];
        let mut ml = MoveList::new();
        for p in b.players() {
            for d in 1..=6u8 {
                ml.clear();
                legal_moves(b, p.color, d, singles, &mut ml);
                for m in ml.as_slice() {
                    for &(c, t) in m.captures() {
                        let prog = b.of(c).tokens[t as usize];
                        bits[c as usize] |= 1u64 << prog;
                    }
                }
            }
        }
        Threats { bits }
    }

    #[inline]
    pub fn get(&self, color: u8, progress: i8) -> bool {
        let sq = square_of(color, progress);
        if sq < 0 || is_safe(sq) {
            return false;
        }
        (self.bits[color as usize] >> progress) & 1 == 1
    }
}

/// rules.ts isThreatened, answered directly from the enemy tokens that could land on the square.
///
/// A capture lands on the captured token's square `sq`. An enemy token at progress e reaches it with
/// the enemy's own progress tp (its unique track progress for `sq`):
///  - a single move of d = tp - e in 1..6: legal when the token is not locked in a double and no other
///    person's double stands on the squares in between; it captures when doubles are off, or when
///    `color` has an odd count on `sq` (a single kills the lone single of a stack);
///  - a pair move of h = tp - e in 1..3 (doubles on, a group of 2+ at e, no block check): captures when
///    `color` has 2+ on `sq`.
/// `Threats::of` (every move of every colour for rolls 1-6, as rules.ts would generate them) is the
/// reference; tests/parity checks both agree on every queried position.
pub fn is_threatened(b: &Board, color: u8, progress: i8, singles: bool) -> bool {
    let sq = square_of(color, progress);
    if sq < 0 || is_safe(sq) {
        return false;
    }
    let me = b.owner_of(color);
    let mine_here = b.count_at(color, sq);
    let single_kills = mine_here >= 1 && (singles || mine_here % 2 == 1);
    let pair_kills = !singles && mine_here >= 2;
    for p in b.players() {
        if p.owner == me {
            continue;
        }
        let tp = ((sq - START[p.color as usize]) % TRACK_LEN + TRACK_LEN) % TRACK_LEN;
        if tp > LAST_TRACK as i32 {
            continue;
        }
        let tp = tp as i8;
        for (i, &e) in p.tokens.iter().enumerate() {
            if e < 0 || e > LAST_TRACK || e >= tp || tp - e > 6 {
                continue;
            }
            // the first token at e stands for the stack (legalMoves dedupes by progress)
            if p.tokens[..i].contains(&e) {
                continue;
            }
            let d = tp - e;
            if single_kills && !is_locked(b, p.color, e, singles) {
                let mut clear = true;
                for q in (e + 1)..tp {
                    let s2 = square_of(p.color, q);
                    if s2 >= 0 && is_blocked_for(b, s2, p.color, singles) {
                        clear = false;
                        break;
                    }
                }
                if clear {
                    return true;
                }
            }
            if pair_kills && d <= 3 && p.tokens.iter().filter(|&&x| x == e).count() >= 2 {
                return true;
            }
        }
    }
    false
}

/// A move that takes a threatened token or double to a star or into the home column.
pub fn is_escape(b: &Board, m: &Move, singles: bool) -> bool {
    if m.kind == KIND_RELEASE || !is_threatened(b, m.color, m.from, singles) {
        return false;
    }
    if m.to >= HOME_FIRST {
        return true;
    }
    let sq = square_of(m.color, m.to);
    sq >= 0 && is_safe(sq)
}
