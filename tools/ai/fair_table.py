"""Strength table on FAIR dice (the engine's training and measuring dice), with the Rust arena.

  python tools/ai/fair_table.py --bin sim-rs/target/release --net gen3=/path/net.json --hard2 /path/hard2-tuned.json
                                [--seeds2 10000] [--seeds4 5000] [--threads 16] [--wandb-group final]

Rows: the net (the app's Extreme spec, net:<file>: depth 1, theirK 3, full chance cap) against hard2-tuned
(net:<file>:1), Hard v1 and Random, then hard2-tuned against Hard v1 and Random; 2p and 4p each. Paired
seeds: A plays every seat of a seed once against B everywhere else, on the same dice. win = A's person
finishes first; ahead = the share of opponents A finishes ahead of, (people - place) / (people - 1); se
is over seeds. Rows print as they finish (TABLE lines) and go to W&B as one table (job_type eval).
"""
import argparse
import json
import math
import subprocess
import time


def arena(bin_dir, a, b, mode, seeds, threads):
    cmd = [f"{bin_dir}/ludo-arena", "--a", a, "--b", b, "--mode", mode, "--from", "0", "--to", str(seeds), "--dice", "fair", "--threads", str(threads)]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    r = json.loads(out.strip().splitlines()[-1].split("ARENA ", 1)[1])
    n, p = r["games"], r["people"]
    m = r["wins"] / r["seeds"]
    return {
        "win": r["wins"] / n,
        "se": math.sqrt(max(r["seedSq"] / r["seeds"] - m * m, 0.0) / r["seeds"]) / p,
        "ahead": (p - r["placeSum"] / n) / (p - 1),
        "games": n,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", required=True)
    ap.add_argument("--net", required=True, help="name=path of the value net")
    ap.add_argument("--hard2", required=True, help="hard2-tuned rules json")
    ap.add_argument("--seeds2", type=int, default=10000)
    ap.add_argument("--seeds4", type=int, default=5000)
    ap.add_argument("--threads", type=int, default=16)
    ap.add_argument("--rules-rows", type=int, default=1, help="also hard2-tuned vs Hard v1 / Random")
    ap.add_argument("--wandb-group", default="final")
    ap.add_argument("--commit", default="")
    a = ap.parse_args()
    name, path = a.net.split("=", 1)
    h2 = f"net:{a.hard2}:1"
    matches = [(name, f"net:{path}", opp, mode) for opp in [h2, "hard", "random"] for mode in ["2p", "4p"]]
    if a.rules_rows:
        matches += [("hard2-tuned", h2, opp, mode) for opp in ["hard", "random"] for mode in ["2p", "4p"]]
    rows = []
    for an, sa, sb, mode in matches:
        t = time.time()
        r = arena(a.bin, sa, sb, mode, a.seeds2 if mode == "2p" else a.seeds4, a.threads)
        bn = "hard2-tuned" if sb == h2 else sb
        row = {"a": an, "b": bn, "mode": mode, **r, "secs": round(time.time() - t, 1)}
        rows.append(row)
        print("TABLE", json.dumps(row), flush=True)
    import wandb

    run = wandb.init(entity="ablations-tinycompany-ai", project="tag-team-ludo-ai", group=a.wandb_group, job_type="eval",
                     name=f"fair-table-{name}", config={"net": name, "dice": "fair", "rust_commit": a.commit, "seeds2": a.seeds2, "seeds4": a.seeds4})
    cols = list(rows[0].keys())
    run.log({"fair_table": wandb.Table(columns=cols, data=[[r[c] for c in cols] for r in rows])})
    for r in rows:
        run.summary[f"{r['a']}_vs_{r['b']}_{r['mode']}_win"] = r["win"]
    run.finish()
    print("TABLE_DONE", flush=True)


if __name__ == "__main__":
    main()
