import marimo

__generated_with = "0.25.2"
app = marimo.App(width="medium", auto_download=["html"])


@app.cell(hide_code=True)
def init():
    # Tag Team Ludo: self-play training for the Extreme bot.
    # The rules run as the game's own TypeScript (Node); torch trains the value net on the GPU.
    import os, sys, json, glob, time, subprocess, pathlib
    import marimo as mo

    WORK = pathlib.Path("/home/marimo/work")
    REPO = WORK / "Tag-Team-Ludo"
    BRANCH = "feat/ai-engine"
    DATA = WORK / "data"      # self-play shards
    NETS = WORK / "nets"      # trained weights, one file per generation
    LOGS = WORK / "logs"
    # W&B: this account's only entity is the team below; change it here (jobs inherit it) to move new runs.
    WANDB_ENTITY = "ablations-tinycompany-ai"
    WANDB_PROJECT = "tag-team-ludo-ai"
    os.environ["LUDO_WANDB_ENTITY"] = WANDB_ENTITY
    for _d in (WORK, DATA, NETS, LOGS):
        _d.mkdir(parents=True, exist_ok=True)


    def sh(cmd, cwd=None, check=True):
        """Runs a shell command, prints its output, returns it."""
        r = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, executable="/bin/bash")
        out = (r.stdout + r.stderr).strip()
        print(out)
        if check and r.returncode:
            raise RuntimeError(f"exit {r.returncode}: {cmd}")
        return out


    def launch(name, script):
        """Starts a long job detached from the kernel, logging to LOGS/<name>.log. Never starts it twice."""
        log = LOGS / f"{name}.log"
        if log.exists() and "END" not in log.read_text() and time.time() - log.stat().st_mtime < 600:
            print(f"{name} is already running: {log}")
            return log
        job = LOGS / f"{name}.sh"
        job.write_text("set -uo pipefail\nexport PYTHONUNBUFFERED=1\necho START $(date -Is)\n" + script + "\necho END $(date -Is)\n")
        subprocess.Popen(f"nohup bash {job} > {log} 2>&1 &", shell=True, start_new_session=True, executable="/bin/bash")
        print(f"started {name}: {log}")
        return log


    def tail(name, n=15):
        """The last lines of a job's log."""
        log = LOGS / f"{name}.log"
        print("\n".join(log.read_text().splitlines()[-n:]) if log.exists() else f"no log yet: {log}")


    return (
        BRANCH,
        DATA,
        LOGS,
        NETS,
        REPO,
        WANDB_ENTITY,
        WANDB_PROJECT,
        WORK,
        json,
        launch,
        mo,
        os,
        pathlib,
        sh,
        sys,
        tail,
        time,
    )


@app.cell
def box(os, sh):
    # The box: cores, memory, GPU, and the tools this notebook needs.
    import torch

    print("cpus", os.cpu_count())
    sh("free -g | head -2; nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader; node --version; npm --version; git --version")
    print("torch", torch.__version__, "cuda", torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else "")

    return


@app.cell
def code(BRANCH, REPO, sh):
    # The game's code at the tip of the branch, with the AI tools bundled for Node (tools/ai/build.sh).
    # Re-run this cell after every push; COMMIT records which code the next runs use.
    if not (REPO / ".git").exists():
        sh(f"git clone -q --branch {BRANCH} https://github.com/JuteBags/Tag-Team-Ludo.git {REPO}")
    sh(f"git fetch -q origin {BRANCH} && git reset -q --hard origin/{BRANCH}", cwd=REPO)
    if not (REPO / "node_modules" / ".bin" / "rolldown").exists():
        sh("npm ci --no-audit --no-fund --loglevel=error", cwd=REPO)
    sh("bash tools/ai/build.sh", cwd=REPO)
    COMMIT = sh("git log -1 --format='%h %s'", cwd=REPO)

    return (COMMIT,)


@app.cell
def preflight(COMMIT, DATA, REPO, sh, time):
    # Preflight: a small self-play shard and a small arena, end to end, with their speed on one core.
    COMMIT
    _t = time.time()
    sh(f"node tools/ai/dist/selfplay.mjs --games 300 --seed 999 --pool hard:6,normal:2,easy:1,random:1 --keep 0.1 --out {DATA}/preflight.bin", cwd=REPO)
    sh(f"node tools/ai/dist/arena.mjs --a hard --b random --mode 2p --from 0 --to 200", cwd=REPO)
    print(f"preflight took {time.time() - _t:.0f}s")

    return


@app.cell
def boot_games(COMMIT, DATA, LOGS, REPO, launch):
    # Phase 1, bootstrap games: 1M games by the rule bots (each person drawn from Hard 65%, Normal 22%,
    # Easy 10%, random 3%) over every table setup, doubles on and off. Labels are only the real results.
    # Every position before a roll can be kept (turn starts and mid-turn), 1.2% of them, about 10 a game.
    # 18 workers write data/boot2/shard-<k>.bin; a shard that exists is skipped, so the job can resume.
    COMMIT
    BOOT = DATA / "boot2"
    BOOT.mkdir(exist_ok=True)
    _workers, _games = 18, 56_000
    _script = f"cd {REPO}\necho CODE $(git log -1 --format=%h)\n" + "\n".join(
        f"[ -f {BOOT}/shard-{k}.bin ] || node tools/ai/dist/selfplay.mjs --games {_games} --seed {k + 1} "
        f"--pool hard:65,normal:22,easy:10,random:3 --keep 0.012 --commit $(git log -1 --format=%h) "
        f"--out {BOOT}/shard-{k}.tmp > {LOGS}/boot-{k}.log 2>&1 && mv {BOOT}/shard-{k}.tmp {BOOT}/shard-{k}.bin &"
        for k in range(_workers)
    ) + "\nwait\nls -la " + str(BOOT)
    launch("boot2-games", _script)

    return (BOOT,)


@app.cell
def watch(LOGS, sh, tail):
    # Progress of the running jobs: re-run this cell to refresh.
    for _name in sorted(p.stem for p in LOGS.glob("*.sh")):
        print(f"== {_name}")
        tail(_name, 4)
    _parts = sorted(LOGS.glob("boot-[0-9]*.log"), key=lambda p: -p.stat().st_mtime)
    if _parts:
        print("== boot workers:", " | ".join(((p.read_text().strip().splitlines() or ["(starting)"])[-1])[:40] for p in _parts[:6]), "...")
    sh("nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader; uptime", check=False)

    return


@app.cell
def boot_train(BOOT, COMMIT, NETS, REPO, launch, sys):
    # Phase 1, bootstrap nets: four variants trained on the bootstrap games, one after another on the GPU.
    # all = every input; margin = also predicts steps left at the end; hand = only the 19 hand features;
    # raw = only the token blocks, turn order and turn in progress. Each run logs to W&B
    # (ablations-tinycompany-ai/tag-team-ludo-ai, group phase1-bootstrap) and must pass TS/torch parity.
    COMMIT
    BOOT_NETS = {
        "boot-all": "--inputs all",
        "boot-margin": "--inputs all --margin 0.2",
        "boot-hand": "--inputs hand",
        "boot-raw": "--inputs raw",
    }
    _py = sys.executable
    _ready = len(list(BOOT.glob("shard-*.bin"))) == 18
    if not _ready:
        print("waiting for the 18 bootstrap shards:", len(list(BOOT.glob("shard-*.bin"))), "done")
    else:
        launch("boot-train", f"cd {REPO}\necho CODE $(git log -1 --format=%h)\n" + "\n".join(
            f"[ -f {NETS}/{n}.json ] || {_py} -u tools/ai/train.py --shards '{BOOT}/shard-*.bin' --out {NETS}/{n}.json "
            f"--hidden 128 --layers 2 --epochs 6 {args} --wandb {n} --group phase1-bootstrap"
            for n, args in BOOT_NETS.items()
        ))

    return (BOOT_NETS,)


@app.cell
def arena_lib(LOGS, REPO, json, launch):
    # Arena helpers: a match is policy A vs policy B on paired seeds, split over 18 workers in one job.
    import math


    def arena(name, a, b, mode="2p", seeds=10_000, workers=18):
        """Launches the match as job `name` (A in each seat of every seed)."""
        step = math.ceil(seeds / workers)
        return launch(name, f"cd {REPO}\necho CODE $(git log -1 --format=%h)\n" + "\n".join(
            f"node tools/ai/dist/arena.mjs --a {a} --b {b} --mode {mode} --from {k * step} --to {min(seeds, (k + 1) * step)} &"
            for k in range(workers)
        ) + "\nwait")


    def arenas(job, matches, seeds=10_000, workers=18):
        """Runs several matches one after another in one job; each still gets its own log (LOGS/arena-<name>.log).
        `matches` maps a name to (A, B, mode). Matches whose log exists are skipped."""
        step = math.ceil(seeds / workers)
        parts = []
        for name, (a, b, mode) in matches.items():
            log = LOGS / f"arena-{name}.log"
            if log.exists():
                continue
            runs = "\n".join(
                f"node tools/ai/dist/arena.mjs --a {a} --b {b} --mode {mode} --from {k * step} --to {min(seeds, (k + 1) * step)} &"
                for k in range(workers)
            )
            parts.append("{ echo START $(date -Is)\n" + runs + "\nwait\necho END $(date -Is); } > " + str(log) + " 2>&1")
        if not parts:
            return None
        return launch(job, f"cd {REPO}\necho CODE $(git log -1 --format=%h)\n" + "\n".join(parts))


    def score(name):
        """A's result in a finished match: win rate with a 95% interval, and the mean place."""
        log = LOGS / f"{name}.log"
        rows = [json.loads(l[6:]) for l in log.read_text().splitlines() if l.startswith("ARENA ")] if log.exists() else []
        if not rows:
            return {"match": name, "status": "no results yet"}
        g = sum(r["games"] for r in rows)
        w = sum(r["wins"] for r in rows)
        p = w / g
        # The error bar is over seeds (each seed is A in every seat, the paired outcome), not single games.
        _s = sum(r["seeds"] for r in rows)
        _m = w / _s
        _se = math.sqrt(max(0.0, sum(r["seedSq"] for r in rows) / _s - _m * _m) / _s) / rows[0]["people"]
        return {"match": name, "a": rows[0]["a"].split("/")[-1], "b": rows[0]["b"], "mode": rows[0]["mode"], "games": g,
                "win": f"{100 * p:.1f}% ± {196 * _se:.1f}",
                "place": round(sum(r["placeSum"] for r in rows) / g, 3), "parts": f"{len(rows)}/18",
                "p": p, "ci": 1.96 * _se,
                "first_win": sum(r.get("firstWins", 0) for r in rows) / max(1, sum(r.get("firstGames", 0) for r in rows)),
                "later_win": (w - sum(r.get("firstWins", 0) for r in rows)) / max(1, g - sum(r.get("firstGames", 0) for r in rows)),
                "best_of_5": best_of(p), "done": "END" in log.read_text()}


    def best_of(p, n=5):
        """Chance of winning a best-of-n match when each game is won with chance p."""
        return sum(math.comb(n, k) * p ** k * (1 - p) ** (n - k) for k in range(n // 2 + 1, n + 1))


    return arenas, math, score


@app.cell
def boot_arena(BOOT_NETS, NETS, arenas, mo, score):
    # Phase 1, strength: Hard vs Hard (the bare seat advantage), then each bootstrap net at depth 1 (my whole
    # turn, no opponent turn) against Hard. 2 players, 10k seeds x 2 seats = 20k paired games per match,
    # run one after another in one job.
    BOOT_MATCHES = {"hard-vs-hard": ("hard", "hard", "2p")} | {n: (f"net:{NETS}/{n}.json:1", "hard", "2p") for n in BOOT_NETS}
    if all((NETS / f"{n}.json").exists() for n in BOOT_NETS):
        arenas("boot-arenas", BOOT_MATCHES)
    mo.ui.table([{k: v for k, v in score(f"arena-{m}").items() if k not in ("p", "ci")} for m in BOOT_MATCHES], selection=None)

    return


@app.cell
def eval_log(COMMIT, LOGS, WANDB_ENTITY, WANDB_PROJECT, mo, score):
    # Logs every finished arena match to W&B as a short eval run (once each; a marker file remembers),
    # plus a table of all matches so far, so one view compares the nets.
    import wandb


    def log_matches(group="phase1-bootstrap"):
        done = []
        for _log in sorted(LOGS.glob("arena-*.log")):
            _name = _log.stem
            _r = score(_name)
            if not _r.get("done"):
                continue
            done.append(_r)
            _mark = LOGS / f"{_name}.wandb"
            if _mark.exists():
                continue
            _pol = _r["a"].split(":")
            _run = wandb.init(entity=WANDB_ENTITY, project=WANDB_PROJECT, name=f"eval-{_name[6:]}",
                              group=group, job_type="eval", reinit="finish_previous",
                              config={"a": _r["a"], "b": _r["b"], "mode": _r["mode"], "depth": _pol[1] if len(_pol) > 1 else "",
                                      "theirK": _pol[2] if len(_pol) > 2 else "", "engine_commit": COMMIT.split()[0],
                                      "eval_suite": "v1: paired seeds, A in every seat, game dice, CI over seeds"})
            _key = f"strength/{_r['mode']}/{_r['b']}"
            _run.summary.update({f"{_key}/win_rate": _r["p"], f"{_key}/ci95_lo": _r["p"] - _r["ci"], f"{_key}/ci95_hi": _r["p"] + _r["ci"],
                                 f"{_key}/mean_place": _r["place"], f"{_key}/games": _r["games"], f"{_key}/best_of_5": _r["best_of_5"],
                                 f"{_key}/win_moving_first": _r["first_win"], f"{_key}/win_moving_later": _r["later_win"]})
            _run.finish()
            _mark.write_text(_run.url)
            print("logged", _name, _run.url)
        return done


    MATCHES = log_matches()
    mo.ui.table(MATCHES, selection=None) if MATCHES else "no finished matches yet"

    return (wandb,)


@app.cell
def boot_data_log(COMMIT, LOGS, WANDB_ENTITY, WANDB_PROJECT, wandb):
    # Logs the bootstrap data to W&B once (a "data" run): games, positions, speed per worker, the policy
    # pool and the setup mix. The shards themselves stay on the box (and HF later), not in W&B.
    _mark = LOGS / "boot2-data.wandb"
    _logs = [LOGS / f"boot-{k}.log" for k in range(18)]
    _done = [l.read_text().strip().splitlines()[-1] for l in _logs if l.exists() and "DONE" in l.read_text()]
    if len(_done) < 18:
        print("bootstrap workers done:", len(_done), "of 18")
    elif _mark.exists():
        print("logged:", _mark.read_text())
    else:
        _rows = [[k, int(d.split()[1]), int(d.split()[3]), float(d.split()[5])] for k, d in enumerate(_done)]
        _run = wandb.init(entity=WANDB_ENTITY, project=WANDB_PROJECT, name="boot2-data", group="phase1-bootstrap",
                          job_type="data", reinit="finish_previous",
                          config={"pool": "hard:65,normal:22,easy:10,random:3", "keep": 0.012, "workers": 18,
                                  "modes": "2p,3p,4p,2h-opposite,2h-side, each with doubles on and off", "engine_commit": COMMIT.split()[0]})
        _run.summary.update({"games": sum(r[1] for r in _rows), "positions": sum(r[2] for r in _rows),
                             "games_per_s_total": sum(r[3] for r in _rows)})
        _run.log({"workers": wandb.Table(columns=["worker", "games", "positions", "games_per_s"], data=_rows)})
        _run.finish()
        _mark.write_text(_run.url)
        print("logged", _run.url)

    return


@app.cell
def profile_node(COMMIT, LOGS, REPO, json, mo, pathlib, sh):
    # Speed study 0: where Node spends self-play time (V8 CPU profile, self time per function), for rule bots
    # and, once a net exists, for the net at depth 1. Shows what a faster engine would actually speed up.
    COMMIT
    PROF = LOGS / "prof"
    PROF.mkdir(exist_ok=True)


    def node_profile(tag, pool, games):
        """Profiles one self-play run and returns the top functions by self time."""
        _dir = PROF / tag
        if not _dir.exists():
            _dir.mkdir()
            sh(f"node --cpu-prof --cpu-prof-dir {_dir} tools/ai/dist/selfplay.mjs --games {games} --seed 4242 --pool {pool} "
               f"--keep 0.012 --out {PROF}/{tag}.bin", cwd=REPO)
        _p = json.loads(next(_dir.glob("*.cpuprofile")).read_text())
        _dt = (_p["endTime"] - _p["startTime"]) / max(1, len(_p["samples"]))
        _self = {}
        for _n in _p["nodes"]:
            _f = _n["callFrame"]
            _k = f'{_f["functionName"] or "(anonymous)"} ({pathlib.Path(_f["url"]).name}:{_f["lineNumber"] + 1})' if _f["url"] else _f["functionName"] or "(program)"
            _self[_k] = _self.get(_k, 0) + _n.get("hitCount", 0)
        _total = sum(_self.values())
        return [{"profile": tag, "function": k, "self_%": round(100 * v / _total, 1), "self_ms": round(v * _dt / 1000)}
                for k, v in sorted(_self.items(), key=lambda kv: -kv[1])[:20]]


    PROFILE_RULES = node_profile("rules", "hard:65,normal:22,easy:10,random:3", 1500)
    mo.ui.table(PROFILE_RULES, selection=None)

    return (PROFILE_RULES,)


@app.cell
def curve(BOOT, NETS, REPO, arenas, launch, mo, score, sys):
    # Learning curve: the "all" net trained on fewer games (whole shards, about 56k games each), to see
    # whether more games still help. 1M games is boot-all itself. Then each one at depth 1 against Hard.
    # W&B group phase1-curve; each point is labelled by games and positions.
    CURVE_NETS = {"curve-112k": 112_000, "curve-336k": 336_000}
    _train = [f"[ -f {NETS}/{n}.json ] || {sys.executable} -u tools/ai/train.py --shards '{BOOT}/shard-*.bin' "
              f"--max-games {g} --out {NETS}/{n}.json --hidden 128 --layers 2 --epochs 6 --inputs all --wandb {n} --group phase1-curve"
              for n, g in CURVE_NETS.items()]
    if not all((NETS / f"{n}.json").exists() for n in CURVE_NETS):
        launch("curve-train", f"cd {REPO}\necho CODE $(git log -1 --format=%h)\n" + "\n".join(_train))
    else:
        arenas("curve-arenas", {n: (f"net:{NETS}/{n}.json:1", "hard", "2p") for n in CURVE_NETS})
    mo.ui.table([{k: v for k, v in score(f"arena-{n}").items() if k not in ("p", "ci")} for n in [*CURVE_NETS, "boot-all"]], selection=None)

    return


@app.cell
def search_gain(LOGS, NETS, arenas, mo, score):
    # What search alone is worth, with the same net (boot-all): depth 2 (my turn, then the next player's
    # turn with their 3 best moves by the Hard rules) against Hard, and depth 2 against depth 1.
    # 5k seeds x 2 seats = 10k paired games each: depth 2 is about 10x slower per game.
    SEARCH_MATCHES = {
        "boot-all-d2": (f"net:{NETS}/boot-all.json:2:3", "hard", "2p"),
        "boot-all-d2-vs-d1": (f"net:{NETS}/boot-all.json:2:3", f"net:{NETS}/boot-all.json:1", "2p"),
    }
    _busy = [l for l in LOGS.glob("arena-*.log") if "END" not in l.read_text()]
    if not _busy:
        arenas("search-arenas", SEARCH_MATCHES, seeds=5_000)
    else:
        print("waiting for running matches:", [l.stem for l in _busy])
    mo.ui.table([{k: v for k, v in score(f"arena-{m}").items() if k not in ("p", "ci")} for m in SEARCH_MATCHES], selection=None)

    return


@app.cell
def hard2(
    BOOT,
    COMMIT,
    LOGS,
    NETS,
    REPO,
    arenas,
    json,
    launch,
    mo,
    score,
    sh,
    sys,
):
    # Hard v2: readable rules. A weighted sum of the 19 plain features judges a position, and the bot plans
    # its whole turn with it (every order of the tray's dice, each extra roll's chances), like Extreme does.
    # Step 1 fits the weights to the bootstrap games' real results (W&B group hard2, run hard2-fit).
    # Step 2 (matches): Hard v2 vs Hard, and the bootstrap net (Extreme v0) vs Hard v2, 20k paired games each.
    COMMIT
    HARD2 = NETS / "hard2-fit.json"
    if not HARD2.exists():
        launch("hard2-fit", f"cd {REPO}\n{sys.executable} -u tools/ai/train.py --shards '{BOOT}/shard-*.bin' --linear "
                            f"--out {HARD2} --epochs 4 --lr 0.05 --wandb hard2-fit --group hard2")
        print("fitting Hard v2 weights")
    else:
        sh(f"node tools/ai/dist/parity.mjs --net {HARD2}", cwd=REPO)
        print(json.dumps(json.loads(HARD2.read_text())["weights"], indent=1))
        HARD2_MATCHES = {
            "hard2-vs-hard": (f"net:{HARD2}:1", "hard", "2p"),
            "boot-all-vs-hard2": (f"net:{NETS}/boot-all.json:1", f"net:{HARD2}:1", "2p"),
        }
        _busy = [l.stem for l in LOGS.glob("arena-*.log") if "END" not in l.read_text()]
        if _busy:
            print("waiting for running matches:", _busy)
        else:
            arenas("hard2-arenas", HARD2_MATCHES)
        mo.ui.table([{k: v for k, v in score(f"arena-{m}").items() if k not in ("p", "ci")} for m in HARD2_MATCHES], selection=None)

    return (HARD2,)


@app.cell
def rust_build(WORK, launch, pathlib, sh):
    # Rust engine (TKF's port, branch feat/sim-rs, crate sim-rs/): its own checkout next to the main one,
    # rustup if the box has no cargo, then a release build. Re-run after every push to feat/sim-rs.
    SIMRS = WORK / "sim-rs-tree"
    CARGO = pathlib.Path.home() / ".cargo" / "bin" / "cargo"
    if not (SIMRS / ".git").exists():
        sh(f"git clone -q --branch feat/sim-rs https://github.com/JuteBags/Tag-Team-Ludo.git {SIMRS}")
    sh("git fetch -q origin feat/sim-rs && git reset -q --hard origin/feat/sim-rs && git log -1 --format='%h %s'", cwd=SIMRS)
    _setup = "" if CARGO.exists() else "curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal\n"
    launch("rust-build", f"{_setup}cd {SIMRS}/sim-rs\n{CARGO} --version\n{CARGO} build --release 2>&1 | tail -5\nls -la target/release/ludo-trace")

    return (SIMRS,)


@app.cell
def rust_parity(DATA, HARD2, LOGS, NETS, REPO, SIMRS, launch, math, sys, tail):
    # The gate for the Rust engine: the TypeScript engine and Rust trace the same games, compared game by
    # game; zero mismatches allowed. Three sets, each split over 18 TS workers by game range:
    #   rules: 1M games, seed 3, every setup, the rule bots (random, easy, normal, hard);
    #   net1:  3,600 games, seed 4: the bootstrap net and Hard v2 at depth 1, with Hard and random;
    #   net2:  360 games, seed 5: the bootstrap net at depth 2 (theirK 3) and Hard v2 at depth 2, with Hard.
    # Then Rust's speed (--bench) at 1 and 20 threads.
    PARITY_DIR = DATA / "parity"
    PARITY_DIR.mkdir(exist_ok=True)
    _trace = SIMRS / "sim-rs" / "target" / "release" / "ludo-trace"
    PARITY_SETS = {
        "rules": (1_000_000, 3, "random,easy,normal,hard"),
        "net1": (3_600, 4, f"net:{NETS}/boot-all.json:1,hard,net:{HARD2}:1,random"),
        "net2": (360, 5, f"net:{NETS}/boot-all.json:2:3,hard,net:{HARD2}:2:3,hard"),
    }


    def _set(name, n, seed, policies, w=18):
        step = math.ceil(n / w)
        ts = "\n".join(f"node tools/ai/dist/trace.mjs --games {min(step, n - k * step)} --from {k * step} --seed {seed} "
                       f"--policies {policies} --out {PARITY_DIR}/ts-{name}-{k}.jsonl &" for k in range(w) if k * step < n)
        return (f"echo SET {name}\n[ -f {PARITY_DIR}/ts-{name}.jsonl ] || {{\n{ts}\nwait\n"
                f"cat {PARITY_DIR}/ts-{name}-[0-9]*.jsonl > {PARITY_DIR}/ts-{name}.jsonl\n}}\n"
                f"{_trace} --games {n} --seed {seed} --policies {policies} --threads 20 --out {PARITY_DIR}/rs-{name}.jsonl\n"
                f"{sys.executable} tools/ai/trace_diff.py {PARITY_DIR}/ts-{name}.jsonl {PARITY_DIR}/rs-{name}.jsonl")


    _busy = [l.stem for l in LOGS.glob("arena-*.log") if "END" not in l.read_text()]
    if not _trace.exists():
        print("waiting for the Rust build")
    elif _busy:
        print("waiting for running matches:", _busy)
    else:
        launch("rust-parity", f"cd {REPO}\n" + "\n".join(_set(k, *v) for k, v in PARITY_SETS.items())
               + f"\nfor t in 1 20; do echo BENCH threads=$t; {_trace} --games 200000 --seed 3 --threads $t --bench; done")
    tail("rust-parity", 14)

    return


@app.cell
def rust_parity2(DATA, HARD2, NETS, REPO, SIMRS, launch, math, sys, tail):
    # The gate again at format 2 (separate dice stream) and the review fixes (tray rules, memo key, counters):
    # rules 100k games, nets at depth 1 and 2, and the self-play shard compared byte for byte (selfplay.mjs
    # vs ludo-selfplay, the same flags). Zero differences allowed before Rust writes training data.
    PARITY2 = DATA / "parity2"
    PARITY2.mkdir(exist_ok=True)
    _trace = SIMRS / "sim-rs" / "target" / "release" / "ludo-trace"
    _selfplay = SIMRS / "sim-rs" / "target" / "release" / "ludo-selfplay"
    _pool = f"net:{NETS}/boot-all.json:1:3:0.01:2,net:{HARD2}:1:3:0.01:1,hard:1,random:1"
    _sets = {
        "rules": (100_000, 11, "random,easy,normal,hard"),
        "net1": (360, 12, f"net:{NETS}/boot-all.json:1,hard,net:{HARD2}:1:3:0.01,random"),
        "net2": (72, 13, f"net:{NETS}/boot-all.json:2:3,hard,net:{HARD2}:2:3:0.01,easy"),
    }


    def _set2(name, n, seed, policies, w=18):
        step = math.ceil(n / w)
        ts = "\n".join(f"node tools/ai/dist/trace.mjs --games {min(step, n - k * step)} --from {k * step} --seed {seed} "
                       f"--policies {policies} --out {PARITY2}/ts-{name}-{k}.jsonl &" for k in range(w) if k * step < n)
        return (f"echo SET {name}\n{ts}\nwait\ncat {PARITY2}/ts-{name}-[0-9]*.jsonl > {PARITY2}/ts-{name}.jsonl\n"
                f"{_trace} --games {n} --seed {seed} --policies {policies} --threads 20 --out {PARITY2}/rs-{name}.jsonl\n"
                f"{sys.executable} tools/ai/trace_diff.py {PARITY2}/ts-{name}.jsonl {PARITY2}/rs-{name}.jsonl")


    _args = f"--games 200 --seed 31 --keep 0.05 --pool {_pool} --commit gate"
    if not _selfplay.exists():
        print("waiting for the Rust build")
    else:
        launch("rust-parity2", f"cd {REPO}\necho CODE $(git log -1 --format=%h) RUST $(git -C {SIMRS} log -1 --format=%h)\n"
               + "\n".join(_set2(k, *v) for k, v in _sets.items())
               + f"\necho SET selfplay\nnode tools/ai/dist/selfplay.mjs {_args} --out {PARITY2}/ts.bin\n"
               f"{_selfplay} {_args} --threads 20 --out {PARITY2}/rs.bin\n"
               f"cmp {PARITY2}/ts.bin {PARITY2}/rs.bin && echo SHARD identical $(stat -c %s {PARITY2}/rs.bin) bytes")
    tail("rust-parity2", 16)

    return


@app.cell
def hard2_tune(BOOT, HARD2, LOGS, NETS, REPO, SIMRS, launch, sys, tail):
    # Hard v2, tuned: (1) refit the readable rules with the tray rules (dice still in the tray, 6s in a row),
    # then (2) CMA-ES on every weight for strength on the Rust engine: fitness = mean win rate at depth 1
    # against Hard v2 (the fit) and the old Hard, 5k paired seeds each, a fresh block per generation; the
    # result is scored on 10k held-out seeds. W&B group hard2 (runs hard2b-fit, hard2-tune).
    HARD2B = NETS / "hard2b-fit.json"
    HARD2T = NETS / "hard2-tuned.json"
    _arena = f"{SIMRS}/sim-rs/target/release/ludo-arena --threads 20"
    _gate_ok = (LOGS / "rust-parity2.log").exists() and "SHARD identical" in (LOGS / "rust-parity2.log").read_text()
    if not _gate_ok:
        print("waiting for the format-2 Rust gate (rust_parity2)")
    else:
        launch("hard2-tune", f"cd {REPO}\n"
               f"[ -f {HARD2B} ] || {sys.executable} -u tools/ai/train.py --shards '{BOOT}/shard-*.bin' --linear --out {HARD2B} "
               f"--epochs 4 --lr 0.05 --wandb hard2b-fit --group hard2\n"
               f"LUDO_ARENA='{_arena}' {sys.executable} -u tools/ai/tune.py --start {HARD2B} --out {HARD2T} "
               f"--opponent net:{HARD2}:1,hard --pop 16 --seeds 5000 --gens 40 --sigma 0.3 --workers 1 --holdout 10000 "
               f"--tmp {LOGS}/tune-tmp --wandb hard2-tune")
    tail("hard2-tune", 6)

    return (HARD2T,)


@app.cell
def round1(HARD2T, LOGS, NETS, REPO, SIMRS, WORK, launch, sys, tail):
    # Round 1 of the ladder: Extreme climbs by self-play against the tuned Hard v2, on the Rust engine.
    # Generations start at 300k games and grow 1.25x per promotion; labels are the real results (the
    # baseline arm; lambda-return targets come next as a comparison). Target: 80% against Hard v2.
    # Resumable (ladder.py skips finished steps); W&B run ladder-r1 (group ladder).
    LADDER1 = WORK / "ladder-r1"
    _rs = SIMRS / "sim-rs" / "target" / "release"
    _done_tune = (LOGS / "hard2-tune.log").exists() and "END" in (LOGS / "hard2-tune.log").read_text()
    if not (_done_tune and HARD2T.exists()):
        print("waiting for Hard v2 tuning (hard2_tune)")
    else:
        launch("round1", f"cd {REPO}\nexport LUDO_SELFPLAY='{_rs}/ludo-selfplay --threads 1' LUDO_ARENA='{_rs}/ludo-arena --threads 1'\n"
               f"{sys.executable} -u tools/ai/ladder.py --start {NETS}/boot-all.json --hard {HARD2T} --dir {LADDER1} "
               f"--gens 30 --games 300000 --grow 1.25 --max-games 2000000 --workers 18 --seeds 5000 --wandb ladder-r1")
    tail("round1", 8)

    return


@app.cell
def hard2_check(
    HARD2,
    HARD2T,
    LOGS,
    NETS,
    REPO,
    SIMRS,
    json,
    launch,
    mo,
    score,
):
    # Hard v2 tuned, checked on fresh seeds (Rust ludo-arena, 20 threads, 10k paired seeds = 20k games each):
    # against the old Hard, against the untuned fit, and the bootstrap Extreme (boot-all, depth 1) against it,
    # which also measures how fast Rust plays net games. Seeds 20,000,000+ are used nowhere else.
    _rsarena = SIMRS / "sim-rs" / "target" / "release" / "ludo-arena"
    HARD2T_MATCHES = {
        "hard2t-vs-hard": (f"net:{HARD2T}:1", "hard"),
        "hard2t-vs-hard2fit": (f"net:{HARD2T}:1", f"net:{HARD2}:1"),
        "boot-all-vs-hard2t": (f"net:{NETS}/boot-all.json:1", f"net:{HARD2T}:1"),
    }
    _parts = [f"{{ echo START $(date -Is)\n{_rsarena} --threads 20 --a {a} --b {b} --mode 2p --from 20000000 --to 20010000\necho END $(date -Is); }} > {LOGS}/arena-{m}.log 2>&1"
              for m, (a, b) in HARD2T_MATCHES.items() if not (LOGS / f"arena-{m}.log").exists()]
    if _parts:
        launch("hard2t-check", f"cd {REPO}\n" + "\n".join(_parts))
    mo.ui.table([{k: v for k, v in score(f"arena-{m}").items() if k in ("match", "games", "win", "best_of_5", "done")}
                 | {"ms": (json.loads(next((l[6:] for l in (LOGS / f"arena-{m}.log").read_text().splitlines() if l.startswith("ARENA ")), "{}")).get("ms") if (LOGS / f"arena-{m}.log").exists() else None)}
                 for m in HARD2T_MATCHES], selection=None)

    return


@app.cell
def baseline(
    HARD2,
    HARD2T,
    LOGS,
    REPO,
    SIMRS,
    WANDB_ENTITY,
    WANDB_PROJECT,
    json,
    launch,
    mo,
    sh,
    wandb,
):
    # The starting point, reproducible: every rule bot against every other (random, Easy, Normal, Hard from
    # bot.ts, then Hard v2 fit and tuned), 2 players, 10k paired seeds = 20k games per pair, on Rust
    # (seeds 30,000,000+, used nowhere else). Logged to W&B as one "baseline" run with the full win-rate
    # matrix, so the ladder's first rung is on record next to everything built on it.
    BOTS = {"random": "random", "easy": "easy", "normal": "normal", "hard": "hard",
            "hard2-fit": f"net:{HARD2}:1", "hard2-tuned": f"net:{HARD2T}:1"}
    _bin = SIMRS / "sim-rs" / "target" / "release" / "ludo-arena"
    _pairs = [(x, y) for i, x in enumerate(BOTS) for y in list(BOTS)[i + 1:]]
    _cmd = "\n".join(f"echo PAIR {x} {y}; {_bin} --threads 4 --a {BOTS[x]} --b {BOTS[y]} --mode 2p --from 30000000 --to 30010000"
                     for x, y in _pairs)
    _log = LOGS / "baseline.log"
    if not _log.exists():
        launch("baseline", f"cd {REPO}\n{_cmd}")
    BASELINE = {}
    if _log.exists():
        _cur = None
        for _l in _log.read_text().splitlines():
            if _l.startswith("PAIR "):
                _cur = tuple(_l.split()[1:3])
            elif _l.startswith("ARENA ") and _cur:
                _r = json.loads(_l[6:])
                BASELINE[_cur] = _r["wins"] / _r["games"]
    _mark = LOGS / "baseline.wandb"
    if len(BASELINE) == len(_pairs) and not _mark.exists():
        _run = wandb.init(entity=WANDB_ENTITY, project=WANDB_PROJECT, name="baseline-rule-bots", group="baseline",
                          job_type="eval", reinit="finish_previous",
                          config={"bots": BOTS, "games_per_pair": 20000, "seeds": "30000000-30010000", "engine": "Rust ludo-arena",
                                  "rust_commit": sh(f"git -C {SIMRS} log -1 --format=%h"), "eval_suite": "v1: paired seeds, A in every seat"})
        _rows = [[x, y, BASELINE[(x, y)]] for x, y in _pairs]
        _run.log({"baseline/matrix": wandb.Table(columns=["a", "b", "a_win_rate"], data=_rows)})
        _run.summary.update({f"baseline/{x}_vs_{y}": v for (x, y), v in BASELINE.items()})
        _run.finish()
        _mark.write_text(_run.url)
    mo.ui.table([{"a": x, **{y: (f"{100 * BASELINE[(x, y)]:.1f}%" if (x, y) in BASELINE else (f"{100 * (1 - BASELINE[(y, x)]):.1f}%" if (y, x) in BASELINE else "")) for y in BOTS}} for x in BOTS], selection=None)

    return


@app.cell
def record(HARD2T, LOGS, PROFILE_RULES, WANDB_ENTITY, WANDB_PROJECT, wandb):
    # The record for everything that ran outside a W&B run: the Node profile, both Rust parity gates and the
    # Rust speed benchmark (W&B groups speed and parity), plus the tuned Hard v2's weights as a model artifact.
    # Each is logged once; a marker file remembers.
    def _once(name, fn):
        _m = LOGS / f"{name}.wandb"
        if _m.exists():
            return _m.read_text()
        url = fn()
        _m.write_text(url)
        return url


    def _parity_run(job, name):
        _txt = (LOGS / f"{job}.log").read_text().splitlines()
        _rows, _set = [], None
        for _l in _txt:
            if _l.startswith("SET "):
                _set = _l.split()[1]
            elif _l.startswith("DIFF "):
                _w = _l.split()
                _rows.append([_set, int(_w[4]), int(_w[6]), int(_w[8])])
            elif _l.startswith("SHARD identical"):
                _rows.append(["selfplay-shard", 200, 0, 0])
        _bench = {f"speed/rust_games_per_s_{_l.split('threads ')[1].split()[0]}t": float(_l.split()[3]) for _l in _txt if "(bench" in _l}
        _run = wandb.init(entity=WANDB_ENTITY, project=WANDB_PROJECT, name=name, group="parity", job_type="parity", reinit="finish_previous",
                          config={"ts_vs_rust": "trace.mjs vs ludo-trace, trace_diff.py; selfplay.mjs vs ludo-selfplay (cmp)",
                                  "log_head": "\n".join(_txt[:2])})
        _run.log({"parity/sets": wandb.Table(columns=["set", "games", "mismatches", "missing"], data=_rows)})
        _run.summary.update({"parity/all_zero": all(r[2] == 0 and r[3] == 0 for r in _rows), **_bench})
        _run.finish()
        return _run.url


    def _speed_run():
        _run = wandb.init(entity=WANDB_ENTITY, project=WANDB_PROJECT, name="node-profile", group="speed", job_type="profile", reinit="finish_previous",
                          config={"what": "V8 CPU profile, self time per function, 1500 rule-bot self-play games, one process"})
        _run.log({"speed/node_profile": wandb.Table(columns=["function", "self_pct", "self_ms"],
                                                    data=[[r["function"], r["self_%"], r["self_ms"]] for r in PROFILE_RULES])})
        _run.summary.update({"speed/node_selfplay_games_per_s_1core": 122.7, "speed/rust_net_depth1_games_per_s_20t": round(20000 / 73.981, 1)})
        _run.finish()
        return _run.url


    def _hard2t_artifact():
        _run = wandb.init(entity=WANDB_ENTITY, project=WANDB_PROJECT, name="hard2-tuned-weights", group="hard2", job_type="artifact", reinit="finish_previous")
        _art = wandb.Artifact("hard2-tuned", type="model", metadata={"kind": "linear rules", "tuned_by": "tools/ai/tune.py (CMA-ES, 40 generations)",
                                                                     "held_out_mean_win": 0.6525})
        _art.add_file(str(HARD2T))
        _run.log_artifact(_art)
        _run.finish()
        return _run.url


    RECORD = {
        "parity v1 (format 1)": _once("rust-parity", lambda: _parity_run("rust-parity", "rust-parity-v1")),
        "parity v2 (format 2)": _once("rust-parity2", lambda: _parity_run("rust-parity2", "rust-parity-v2")),
        "node profile + speed": _once("node-profile", _speed_run),
        "hard2-tuned artifact": _once("hard2-tuned", _hard2t_artifact),
    }
    RECORD

    return


@app.cell
def journey(
    COMMIT,
    LOGS,
    SIMRS,
    WANDB_ENTITY,
    WANDB_PROJECT,
    WORK,
    mo,
    pathlib,
    score,
    sh,
    time,
    wandb,
):
    # The journey on one page: every step from the original rule bots to the current ladder, with its result
    # and its W&B run, logged as one table (run "journey", re-logged when re-run) plus a snapshot of this
    # notebook as an artifact, so the whole path can be reviewed and reproduced from W&B alone.
    def _url(marker):
        _m = LOGS / f"{marker}.wandb"
        return _m.read_text() if _m.exists() else ""


    def _win(match):
        _r = score(f"arena-{match}")
        return _r.get("win", "")


    JOURNEY = [
        ["0", "Rule bots (bot.ts): Easy, Normal, Hard, plus random", "round robin, 20k games per pair (baseline cell)", _url("baseline")],
        ["0", "Hard vs Hard: seat advantage", _win("hard-vs-hard"), _url("arena-hard-vs-hard")],
        ["1", "Bootstrap data: 1M rule-bot games (an earlier run with a per-colour objective was stopped and discarded)", "boot2-data", _url("boot2-data")],
        ["1", "Value nets on the bootstrap (all / margin / hand / raw)", "W&B group phase1-bootstrap, train runs boot-*", ""],
        ["1", "Extreme v0 = boot-all at depth 1 vs Hard", _win("boot-all"), _url("arena-boot-all")],
        ["1", "  boot-margin vs Hard", _win("boot-margin"), _url("arena-boot-margin")],
        ["1", "  boot-hand vs Hard", _win("boot-hand"), _url("arena-boot-hand")],
        ["1", "  boot-raw vs Hard", _win("boot-raw"), _url("arena-boot-raw")],
        ["1", "Learning curve: 112k games vs Hard", _win("curve-112k"), _url("arena-curve-112k")],
        ["1", "Learning curve: 336k games vs Hard", _win("curve-336k"), _url("arena-curve-336k")],
        ["2", "Hard v2 fit (readable linear rules + whole-turn search) vs Hard", _win("hard2-vs-hard"),
         _url("arena-hard2-vs-hard") + " (train run hard2-fit shows failed: an absolute parity tolerance, since made relative)"],
        ["2", "Extreme v0 vs Hard v2 fit", _win("boot-all-vs-hard2"), _url("arena-boot-all-vs-hard2")],
        ["2", "Rust engine parity (format 1): 1M rule games, nets at depth 1 and 2", "0 mismatches", _url("rust-parity")],
        ["2", "Rust engine parity (format 2: separate dice stream) + shard byte check", "0 mismatches", _url("rust-parity2")],
        ["2", "Node profile and engine speed", "see run", _url("node-profile")],
        ["2", "Hard v2 tuned (refit with tray rules, CMA-ES, held-out 0.6525)", "W&B runs hard2b-fit, hard2-tune", _url("hard2-tuned")],
        ["2", "Hard v2 tuned vs Hard", _win("hard2t-vs-hard"), _url("arena-hard2t-vs-hard")],
        ["2", "Hard v2 tuned vs Hard v2 fit", _win("hard2t-vs-hard2fit"), _url("arena-hard2t-vs-hard2fit")],
        ["2", "Extreme v0 vs Hard v2 tuned", _win("boot-all-vs-hard2t"), _url("arena-boot-all-vs-hard2t")],
        ["3", "Round 1: Extreme self-play ladder against Hard v2 tuned", "W&B run ladder-r1 (running)", ""],
    ]
    _snap = WORK / "notebook-snapshots"
    _snap.mkdir(exist_ok=True)
    _copy = _snap / f"notebook-{time.strftime('%Y%m%d-%H%M%S')}.py"
    _copy.write_text(pathlib.Path("/marimo/notebook.py").read_text())
    _run = wandb.init(entity=WANDB_ENTITY, project=WANDB_PROJECT, name="journey", group="summary", job_type="summary", reinit="finish_previous",
                      config={"engine_commit": COMMIT.split()[0], "rust_commit": sh(f"git -C {SIMRS} log -1 --format=%h")})
    _run.log({"journey": wandb.Table(columns=["phase", "step", "result", "wandb"], data=JOURNEY)})
    _art = wandb.Artifact("ludo-ai-notebook", type="code", metadata={"cells": "this marimo notebook, every step of the pipeline"})
    _art.add_file(str(_copy), name="notebook.py")
    _run.log_artifact(_art)
    _run.finish()
    mo.ui.table([dict(zip(["phase", "step", "result", "wandb"], r)) for r in JOURNEY], selection=None)

    return


if __name__ == "__main__":
    app.run()
