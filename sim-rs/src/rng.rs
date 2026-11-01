//! src/engine/rng.ts `seeded()`: a mulberry32 variant. u32 wrapping math stands in for JS's `| 0`,
//! `Math.imul` and `>>>`; the output is the u32 / 2^32 as f64, exactly as in JS.

/// Deliberately neither Clone nor Copy: no policy or search can duplicate a stream and read future
/// draws (format 2 gives the dice a stream of their own; this keeps anyone from forking it).
#[derive(Debug)]
pub struct Rng {
    a: u32,
}

impl Rng {
    /// `seed | 0` in JS: ToInt32 of the (integral) seed, i.e. its low 32 bits.
    pub fn seeded(seed: i64) -> Self {
        Rng { a: seed as u32 }
    }

    /// The stream's state (Rng::seeded(state as i64) continues it exactly): for handing streams to the GPU.
    #[inline]
    pub fn state(&self) -> u32 {
        self.a
    }

    #[inline]
    pub fn next(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b_79f5);
        let a = self.a;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }
}

/// tools/ai/common.ts DICE_SALT / diceRngFor (format 2: the dice draw from their own stream).
pub const DICE_SALT: u32 = 0x2545_f491;
pub const FORMAT: u32 = 2;

pub fn dice_rng_for(game_seed: i64) -> Rng {
    Rng::seeded(((game_seed as u32) ^ DICE_SALT) as i64)
}

/// The game's two streams. Format 1 (old shards and traces): one stream for dice and policies alike.
/// Format 2: the dice have their own.
pub struct Streams {
    pub rng: Rng,
    dice: Option<Rng>,
    /// common.ts DiceMode 'fair': every face 1 in 6 (one draw from the dice stream, no shuffle draws).
    /// The engine trains and is measured on fair dice; false = the app's dice (dice.rs weights).
    pub fair: bool,
}

impl Streams {
    pub fn new(rng: Rng, game_seed: i64, format: u32) -> Self {
        Streams { rng, dice: if format >= 2 { Some(dice_rng_for(game_seed)) } else { None }, fair: false }
    }

    /// common.ts rollFace(s, dice, mode): the next face for `color`.
    pub fn roll_face(&mut self, b: &crate::rules::Board, color: u8, singles: bool, ml: &mut crate::rules::MoveList) -> u8 {
        if self.fair {
            crate::dice::sample_face(&crate::dice::FAIR, self.dice())
        } else {
            crate::dice::roll_face(b, color, self.dice(), singles, ml)
        }
    }
    /// The stream the dice draw from.
    #[inline]
    pub fn dice(&mut self) -> &mut Rng {
        match self.dice.as_mut() {
            Some(d) => d,
            None => &mut self.rng,
        }
    }
}
