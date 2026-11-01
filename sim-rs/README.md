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

## Policies, search and the arena

`--policies` / `--a` / `--b` take the same specs as tools/ai/common.ts: `random`, `easy`, `normal`,
`hard`, and `net:<weights.json>[:depth[:theirK[:temperature]]]`, where the weights file is a value net
(net.ts JSON) or linear rules (`"kind": "linear"`). The search (search.rs) is search.ts: whole-turn
expectimax, max^n, chance cap 2, other people pruned to their best `theirK` moves by scoreMove, the
same memo key. `ludo-arena` prints the same `ARENA {...}` line as arena.mjs, so tools/ai/tune.py runs
on it through `LUDO_ARENA`.

Net and rule games replay exactly too: V8 computes Math.exp and Math.tanh with its own port of FreeBSD
msun, and jsmath.rs is that code (`node sim-rs/jsmath_ref.mjs ref.txt && jsmath-check ref.txt`
compares 500k inputs bit for bit). Keep net.ts / linear.ts in f64 with a fixed summation order, or the
exact match is gone.
