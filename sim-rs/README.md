# sim-rs: Rust port of the game engine

A Rust port of `src/engine` (rules, dice, turn flow, the Easy/Normal/Hard bots) for fast self-play.
The TypeScript engine stays the only spec: this port must replay every game exactly like it.

## Parity

`ludo-trace` takes the same flags and writes the same JSON lines as `tools/ai/trace.ts`:

```bash
cargo build --release
node tools/ai/dist/trace.mjs --games 10000 --seed 7 --out ref.jsonl     # TS reference
sim-rs/target/release/ludo-trace --games 10000 --seed 7 --out rs.jsonl # Rust
cmp ref.jsonl rs.jsonl                                                 # byte-identical, or:
python tools/ai/trace_diff.py ref.jsonl rs.jsonl                       # first diverging step per game
```

Add `--full` for step-by-step traces. `cargo test --release` checks the fast threat test against a
brute-force reference on every token of every position of 2,000 games.

## Speed

`--bench` plays the same games without building the step lines and prints games/s; `--threads N`
sets the worker count (default: all cores).
