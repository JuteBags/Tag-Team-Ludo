# Head-to-head: Extreme vs AlphaLudo V17 (#148)

A research benchmark. Our Extreme plays AlphaLudo V17 in **AlphaLudo's rules**: classic one-die Ludo, as their
engine plays it. Nothing here is part of the app, and the app doesn't mention the results.

AlphaLudo is by Sumit Pal. Please cite:

> Sumit Pal. "How a small network got strong." AlphaLudo V17: a 588K-parameter graph transformer for two- and
> four-player Ludo, 2026. https://alphaludo.in/research/

```bibtex
@misc{pal2026alphaludo,
  author = {Pal, Sumit},
  title  = {How a small network got strong},
  year   = {2026},
  url    = {https://alphaludo.in/research/},
  note   = {AlphaLudo V17, a 588K-parameter graph transformer for two- and four-player Ludo}
}
```

Code: https://github.com/sumit7194/AlphaLudo

## Their code and model
Their repository has no licence, so all rights are reserved.
- **The referee** is their `crates/ludo_core` at commit `5d4e498`. Cargo fetches it when the workflow builds this crate.
- **V17** is the ONNX file alphaludo.in serves. The workflow downloads it into the runner's temp dir and checks it against a pinned sha256.

Neither is committed here, cached, uploaded as an artifact or shipped. Only our harness and our results are kept.

## The rules (their `state.rs`)
- One die, one move.
- A 6 brings a token out; three 6s in a row forfeit the turn.
- A 6, a capture or a token home rolls again.
- The finish needs an exact roll (56).
- A lone token on a normal square is captured. 2+ of a colour on a square are immune, but don't block.
- The same 8 safe squares as ours.
- The first player with all four home wins, and the game ends there.

Our side plays these rules in `sim-rs`'s classic mode (`Game::classic`). `h2h parity` checks it against their engine in lockstep over 10,000 games.

## The players
- **`v17`:** V17 as shipped: one forward pass of their policy, the argmax over the legal cells, no search.
- **`extreme-net`:** our Extreme: `choose_race` with 128 playouts, Hard-rule playouts, and our net at the 12-turn cut.
- **`extreme-rules`:** the same with rule-only playouts to the end of the game.

It's an away game for us: our net and our rules were trained and tuned on our own rules (the tray and pairs).

## The matches
- One fair dice stream per seat, seeded by the deal, and every deal played with each side in each seat (2p: 2 games; 4p: 4).
- Games play to the end their rules define: the first player home. `--to-end 1` plays on for every place.
- Even is 50% in 2p and 25% for the lone side in 4p.
- `report.py` gives A's wins with a 95% Wilson interval and one paired by deal, the games cut, and the time per game and per decision.

Run it with `.github/workflows/h2h.yml` (see its header).
