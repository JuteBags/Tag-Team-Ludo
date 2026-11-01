"""The app's level ladder as a check: every level against the level below, in every game mode.

    python tools/ai/levels_check.py --arena sim-rs/target/release/ludo-arena [--seeds 1000]
                                    [--extreme-seeds 0] [--dice fair|app|both] [--threads N]

Levels as the app plays them (src/engine/ai/levels.ts): Easy = the original Hard rule bot, Normal = Hard's
rules judging each move alone, Hard = Hard's rules planning the turn, Extreme = the rollout player
(race:128, the playout rules in the playouts, extreme-net.json at the cut). The rules come from the app's
own files through tools/ai/dist/levels/ (build.sh runs levels-json.ts). Each row is one tested person
against people all of the level below, on the same seeds 0..N-1 every run, so a run is reproducible and a
change in a number is a change in a bot. A row fails when its 95% interval does not clear an even share
(1 / people): the level is no longer a step up from the one below. Writes a markdown table (to
$GITHUB_STEP_SUMMARY when set) and exits 1 on any failed row.
"""
import argparse, json, os, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
LV = ROOT / "tools" / "ai" / "dist" / "levels"
NET = ROOT / "src" / "engine" / "ai" / "extreme-net.json"
LEVELS = {
    "Random": "random",
    "Easy": "hard",
    "Normal": f"greedy:{LV / 'hard.json'}",
    "Hard": f"net:{LV / 'hard.json'}:1",
    "Extreme": f"race:128:12:{NET}:net:{LV / 'playout.json'}:1:3:0:0:1",
}
MODES = [f"{m}{t}" for t in ("", "-singles") for m in ("2p", "3p", "4p", "2h-opposite", "2h-side")]
NAMES = {"2p": "2 players", "3p": "3 players", "4p": "4 players", "2h-opposite": "2 players, 2 houses each (opposite)",
         "2h-side": "2 players, 2 houses each (side by side)"}
STEPS = [("Easy", "Random"), ("Normal", "Easy"), ("Hard", "Normal")]


def run(arena, a, b, mode, seeds, dice, threads):
    cmd = [arena, "--a", LEVELS[a], "--b", LEVELS[b], "--mode", mode, "--from", "0", "--to", str(seeds)]
    cmd += ["--dice", "fair"] if dice == "fair" else []
    cmd += ["--threads", str(threads)] if threads else []
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode:
        sys.exit(f"ludo-arena failed ({proc.returncode}): {' '.join(cmd)}\n{proc.stderr}")
    out = proc.stdout
    r = json.loads(next(l for l in out.splitlines() if l.startswith("ARENA "))[6:])
    p, n, even = r["wins"] / r["games"], r["games"], 1 / r["people"]
    lo = p - 1.96 * (p * (1 - p) / n) ** 0.5
    return {"a": a, "b": b, "mode": mode, "dice": dice, "win": p, "lo": lo, "even": even, "games": n, "ok": lo > even}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arena", required=True)
    ap.add_argument("--seeds", type=int, default=1000)
    ap.add_argument("--extreme-seeds", type=int, default=0)
    ap.add_argument("--dice", choices=["fair", "app", "both"], default="fair")
    ap.add_argument("--threads", type=int, default=0)
    a = ap.parse_args()
    dice = ["fair", "app"] if a.dice == "both" else [a.dice]
    rows = []
    for d in dice:
        for m in MODES:
            for x, y in STEPS:
                rows.append(run(a.arena, x, y, m, a.seeds, d, a.threads))
                print(json.dumps(rows[-1]), flush=True)
            if a.extreme_seeds:
                rows.append(run(a.arena, "Extreme", "Hard", m, a.extreme_seeds, d, a.threads))
                print(json.dumps(rows[-1]), flush=True)
    steps = list(dict.fromkeys((r["a"], r["b"]) for r in rows))
    md = ["## Bot levels: each level vs the level below", "",
          f"One tested person against people all of the level below; {a.seeds} seeds per row"
          + (f" ({a.extreme_seeds} for Extreme)" if a.extreme_seeds else "") + ". Even = 1 / people. A row fails (✗) when its 95% interval does not clear even.", ""]
    for d in dice:
        md += [f"### {'Fair dice' if d == 'fair' else 'App dice'}", "",
               "| Mode | Even | " + " | ".join(f"{x} vs {y}" for x, y in steps) + " |",
               "|---|---|" + "---|" * len(steps)]
        for m in MODES:
            base, tag = m.removesuffix("-singles"), " (no doubles)" if m.endswith("-singles") else ""
            cells = []
            for x, y in steps:
                r = next((r for r in rows if (r["dice"], r["mode"], r["a"], r["b"]) == (d, m, x, y)), None)
                cells.append(f"{100 * r['win']:.1f}%{'' if r['ok'] else ' ✗'}" if r else "")
            even = next(r["even"] for r in rows if r["mode"] == m)
            md.append(f"| {NAMES[base]}{tag} | {100 * even:.1f}% | " + " | ".join(cells) + " |")
        md.append("")
    text = "\n".join(md)
    print(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(text + "\n")
    bad = [r for r in rows if not r["ok"]]
    for r in bad:
        print(f"FAIL {r['dice']} {r['mode']}: {r['a']} vs {r['b']} {100 * r['win']:.1f}% (95% low {100 * r['lo']:.1f}%, even {100 * r['even']:.1f}%)", file=sys.stderr)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
