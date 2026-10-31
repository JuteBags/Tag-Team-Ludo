//! Rust port of the Tag Team Ludo engine (src/engine/*.ts) for fast self-play.
//!
//! Every rule, every rng draw and every float operation in a decision path follows the TypeScript in
//! the same order, so a game replays bit for bit: `tools/ai/trace.ts` and `ludo-trace` write identical
//! trace files for the same seeds. Module per source file: rng.ts, board.ts + rules.ts, dice.ts,
//! game.ts, bot.ts.
pub mod bot;
pub mod dice;
pub mod encode;
pub mod eval;
pub mod game;
pub mod jsmath;
pub mod rng;
pub mod rules;
pub mod search;
pub mod trace;
