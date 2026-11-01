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


    def running(name):
        """True while the job script LOGS/<name>.sh has a live process."""
        import re
        return subprocess.run(["pgrep", "-f", "bash " + re.escape(f"{LOGS / name}.sh") + "$"], capture_output=True).returncode == 0


    def launch(name, script):
        """Starts a long job detached from the kernel, logging to LOGS/<name>.log. Never starts it twice: a live
        process of its job script means it is running (a cell re-run by marimo's lazy mode must be a no-op).
        Jobs run under nice -n 10 so the notebook server always gets the CPU (a starved server gets the box killed)."""
        log = LOGS / f"{name}.log"
        job = LOGS / f"{name}.sh"
        if running(name):
            print(f"{name} is already running: {log}")
            return log
        # unset WANDB_SERVICE: each job gets its own W&B service, so a crashed job's run closes with it.
        job.write_text("set -uo pipefail\nexport PYTHONUNBUFFERED=1\nunset WANDB_SERVICE\necho START $(date -Is)\n" + script + "\necho END $(date -Is)\n")
        subprocess.Popen(f"nohup nice -n 10 bash {job} > {log} 2>&1 &", shell=True, start_new_session=True, executable="/bin/bash")
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
        running,
        sh,
        subprocess,
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
    # The game's code at a pinned commit of the branch, with the AI tools bundled for Node (tools/ai/build.sh).
    # Pinned, so a re-run (marimo's lazy mode re-runs stale cells) never swaps the code under a running job.
    # To move: change ENGINE_COMMIT and run this cell. COMMIT records which code the next runs use.
    ENGINE_COMMIT = "b6527a2"  # + ladder --modes, --pool-weights; + a lambda ladder trains only on generations with targets; + saves after play, gen 0, targets (restore_ladder.py), heartbeat; + lambda labels valued as the blend plays; evolution keeps the final CMA-ES mean or the start (held-out block), 800 seeds; residual + learned temperature (TKF)
    if not (REPO / ".git").exists():
        sh(f"git clone -q --branch {BRANCH} https://github.com/JuteBags/Tag-Team-Ludo.git {REPO}")
    _built = REPO / "tools" / "ai" / "dist" / "BUILT_COMMIT"
    if not (_built.exists() and _built.read_text().strip() == ENGINE_COMMIT):
        sh(f"git fetch -q origin {BRANCH} && git reset -q --hard {ENGINE_COMMIT}", cwd=REPO)
        if not (REPO / "node_modules" / ".bin" / "rolldown").exists():
            sh("npm ci --no-audit --no-fund --loglevel=error", cwd=REPO)
        sh("bash tools/ai/build.sh", cwd=REPO)
        _built.write_text(ENGINE_COMMIT)
    COMMIT = sh("git log -1 --format='%h %s'", cwd=REPO)

    return (COMMIT,)


@app.cell(disabled=True)
def preflight(COMMIT, DATA, REPO, sh, time):
    # Preflight: a small self-play shard and a small arena, end to end, with their speed on one core.
    COMMIT
    _t = time.time()
    sh(f"node tools/ai/dist/selfplay.mjs --games 300 --seed 999 --pool hard:6,normal:2,easy:1,random:1 --keep 0.1 --out {DATA}/preflight.bin", cwd=REPO)
    sh(f"node tools/ai/dist/arena.mjs --a hard --b random --mode 2p --from 0 --to 200", cwd=REPO)
    print(f"preflight took {time.time() - _t:.0f}s")
    return


@app.cell(disabled=True)
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


@app.cell(disabled=True)
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


@app.cell(disabled=True)
def boot_arena(BOOT_NETS, NETS, arenas, mo, score):
    # Phase 1, strength: Hard vs Hard (the bare seat advantage), then each bootstrap net at depth 1 (my whole
    # turn, no opponent turn) against Hard. 2 players, 10k seeds x 2 seats = 20k paired games per match,
    # run one after another in one job.
    BOOT_MATCHES = {"hard-vs-hard": ("hard", "hard", "2p")} | {n: (f"net:{NETS}/{n}.json:1", "hard", "2p") for n in BOOT_NETS}
    if all((NETS / f"{n}.json").exists() for n in BOOT_NETS):
        arenas("boot-arenas", BOOT_MATCHES)
    mo.ui.table([{k: v for k, v in score(f"arena-{m}").items() if k not in ("p", "ci")} for m in BOOT_MATCHES], selection=None)
    return


@app.cell(disabled=True)
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


@app.cell(disabled=True)
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


@app.cell(disabled=True)
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


@app.cell(disabled=True)
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


@app.cell(disabled=True)
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


@app.cell(disabled=True)
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
    # rustup if the box has no cargo, then a release build. Builds the pinned commit below.
    SIMRS = WORK / "sim-rs-tree"
    CARGO = pathlib.Path.home() / ".cargo" / "bin" / "cargo"
    if not (SIMRS / ".git").exists():
        sh(f"git clone -q --branch feat/sim-rs https://github.com/JuteBags/Tag-Team-Ludo.git {SIMRS}")
    # Pinned, so a re-run (marimo's lazy mode re-runs stale cells) never rebuilds under a running job. To move,
    # change RUST_COMMIT, run this cell, then gate2 (one gate per commit).
    RUST_COMMIT = "ce541af"  # TKF: ludo-expert (paired rollout expert data) + the rollout player; before 6d911f1 (ludo-label --eval blend)
    _stamp = SIMRS / "sim-rs" / "target" / "release" / "BUILT_COMMIT"
    sh(f"git fetch -q origin feat/sim-rs && git reset -q --hard {RUST_COMMIT} && git log -1 --format='%h %s'", cwd=SIMRS)
    _setup = "" if CARGO.exists() else "curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal\n"
    if _stamp.exists() and _stamp.read_text().strip() == RUST_COMMIT:
        print(f"built at {RUST_COMMIT}")
    else:
        launch("rust-build", f"{_setup}cd {SIMRS}/sim-rs\n{CARGO} --version\n"
               f"{CARGO} build --release 2>&1 | tail -5 && echo {RUST_COMMIT} > {_stamp}\nls -la target/release/ludo-trace")

    return (SIMRS,)


@app.cell
def restore(NETS, WANDB_ENTITY, WANDB_PROJECT, WORK, json, pathlib):
    # Session 2 (box sb-3b13...): the first box died at about 2 h 45 min with everything on its disk. Every
    # net was saved to W&B as an artifact, so this restores them into NETS by artifact name, and rebuilds the
    # ladder's state after generation 1 (promoted: 55.5% vs the start, 47.5% vs Hard v2 tuned). The games
    # themselves are not needed to continue; from now on every generation's games and logs go to W&B too.
    # Session-2 names (S2_*) keep the session-1 cells, now disabled, as the record of what ran there.
    _restore = {"boot-all": "boot-all.json", "hard2-fit": "hard2-fit.json", "hard2b-fit": "hard2b-fit.json",
                "hard2-tuned": "hard2-tuned.json", "ladder-r1-gen1": "ladder-r1-gen1.json"}
    _api = __import__("wandb").Api()  # wandb is imported by eval_log, a session-1 cell (disabled)
    RESTORED = {}
    for _art, _file in _restore.items():
        _dst = NETS / _file
        if not _dst.exists():
            _a = _api.artifact(f"{WANDB_ENTITY}/{WANDB_PROJECT}/{_art}:latest")
            _dir = pathlib.Path(_a.download(root=str(NETS / f"_art-{_art}")))
            _src = next(p for p in _dir.iterdir() if p.suffix == ".json")
            _dst.write_text(_src.read_text())
        RESTORED[_art] = str(_dst)
    # The ladder's state after generation 1, so round 1 resumes at generation 2 with the promoted net.
    S2_LADDER = WORK / "ladder-r1"
    _g1 = S2_LADDER / "gen-1"
    _g1.mkdir(parents=True, exist_ok=True)
    if not (_g1 / "net.json").exists():
        (_g1 / "net.json").write_text((NETS / "ladder-r1-gen1.json").read_text())
    _state = S2_LADDER / "state.json"
    if not _state.exists():
        _state.write_text(json.dumps({
            "gen": 1, "current": str(_g1 / "net.json"), "previous": str(NETS / "boot-all.json"), "games": 375000,
            "temp": 0.0059730830451646824, "vs_hard_current": 0.4747, "wandb_id": "ladder-r1-20261031-212927",
            "history": [{"gen": 1, "games": 300000, "temp": 0.01, "explored": 0.2088, "vs_current": 0.5553, "vs_current_ci": 0.0093,
                         "vs_hard": 0.4747, "vs_hard_ci": 0.0093, "promoted": True, "play_s": 3224, "learn_s": 28, "total_s": 3296}],
        }, indent=1))
    S2_HARD2 = NETS / "hard2-fit.json"
    S2_HARD2T = NETS / "hard2-tuned.json"
    RESTORED

    return S2_HARD2T, S2_LADDER


@app.cell(disabled=True)
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


@app.cell(disabled=True)
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


@app.cell(disabled=True)
def hard2_tune(BOOT, HARD2, LOGS, NETS, REPO, SIMRS, launch, sys, tail):
    # Hard v2, tuned: (1) refit the readable rules with the tray rules (dice still in the tray, 6s in a row),
    # then (2) CMA-ES on every weight for strength on the Rust engine: fitness = mean win rate at depth 1
    # against Hard v2 (the fit) and the old Hard, 5k paired seeds each, a fresh block per generation; the
    # result is scored on 10k held-out seeds. W&B group hard2 (runs hard2b-fit, hard2-tune).
    HARD2B = NETS / "hard2b-fit.json"
    HARD2T = NETS / "hard2-tuned.json"
    _arena = f"{SIMRS}/sim-rs/target/release/ludo-arena --threads 20"
    _gate_ok = (LOGS / "rust-parity2.log").exists() and "SHARD identical" in (LOGS / "rust-parity2.log").read_text()
    if HARD2T.exists():
        print("tuned:", HARD2T, "(delete it to tune again)")
    elif not _gate_ok:
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


@app.cell(disabled=True)
def round1(HARD2T, NETS, REPO, SIMRS, WORK, launch, sys, tail):
    # Round 1 of the ladder: Extreme climbs by self-play against the tuned Hard v2, on the Rust engine.
    # Generations start at 300k games and grow 1.25x per promotion; labels are the real results (the
    # baseline arm; lambda-return targets come next as a comparison). Target: 80% against Hard v2.
    # Resumable (ladder.py skips finished steps); W&B run ladder-r1 (group ladder).
    LADDER1 = WORK / "ladder-r1"
    _rs = SIMRS / "sim-rs" / "target" / "release"
    if not HARD2T.exists():
        print("waiting for Hard v2 tuning (hard2_tune)")
    else:
        launch("round1", f"cd {REPO}\nexport LUDO_SELFPLAY='{_rs}/ludo-selfplay --threads 1' LUDO_ARENA='{_rs}/ludo-arena --threads 1'\n"
               f"{sys.executable} -u tools/ai/ladder.py --start {NETS}/boot-all.json --hard {HARD2T} --dir {LADDER1} "
               f"--gens 30 --games 300000 --grow 1.25 --max-games 2000000 --workers 18 --seeds 5000 --wandb ladder-r1")
    tail("round1", 8)
    return


@app.cell(disabled=True)
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


@app.cell(disabled=True)
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


@app.cell(disabled=True)
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


@app.cell(disabled=True)
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
        ["2", "Hard v2 tuned (refit with tray rules, CMA-ES, held-out 0.6525)", "W&B runs hard2b-fit, hard2-tune (egy1ufpp)", _url("hard2-tuned")],
        ["2", "  (run 7svx49g5, also named hard2-tune, is an accidental re-launch stopped before its first generation: ignore it)", "", ""],
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


@app.cell(disabled=True)
def rust_gate(
    DATA,
    HARD2T,
    LOGS,
    NETS,
    REPO,
    SIMRS,
    launch,
    math,
    sh,
    sys,
    tail,
):
    # The quick gate after every Rust update (format 2): nets at depth 1 and 2 traced by both engines (180 +
    # 36 games, the bootstrap net and tuned Hard v2), the self-play shard compared byte for byte (200 games),
    # and the evaluation speed (ludo-bench-eval). Zero differences before Rust writes training data again.
    # Each run gets its own folder, named after the Rust commit.
    _rel = SIMRS / "sim-rs" / "target" / "release"
    _rc = sh(f"git -C {SIMRS} log -1 --format=%h")
    GATE = DATA / f"gate-{_rc}"
    GATE.mkdir(exist_ok=True)
    _gpool = f"net:{NETS}/boot-all.json:1:3:0.01:2,net:{HARD2T}:1:3:0.01:1,hard:1,random:1"
    _gsets = {"net1": (180, 41, f"net:{NETS}/boot-all.json:1,hard,net:{HARD2T}:1:3:0.01,random"),
              "net2": (36, 42, f"net:{NETS}/boot-all.json:2:3,hard,net:{HARD2T}:2:3,easy")}


    def _gset(name, n, seed, policies, w=18):
        step = math.ceil(n / w)
        ts = "\n".join(f"node tools/ai/dist/trace.mjs --games {min(step, n - k * step)} --from {k * step} --seed {seed} "
                       f"--policies {policies} --out {GATE}/ts-{name}-{k}.jsonl &" for k in range(w) if k * step < n)
        return (f"echo SET {name}\n{ts}\nwait\ncat {GATE}/ts-{name}-[0-9]*.jsonl > {GATE}/ts-{name}.jsonl\n"
                f"{_rel}/ludo-trace --games {n} --seed {seed} --policies {policies} --threads 20 --out {GATE}/rs-{name}.jsonl\n"
                f"{sys.executable} tools/ai/trace_diff.py {GATE}/ts-{name}.jsonl {GATE}/rs-{name}.jsonl")


    _gargs = f"--games 200 --seed 31 --keep 0.05 --pool {_gpool} --commit gate"
    _job = f"rust-gate-{_rc}"
    if not (LOGS / f"{_job}.log").exists():
        launch(_job, f"cd {REPO}\necho RUST {_rc} CODE $(git log -1 --format=%h)\n" + "\n".join(_gset(k, *v) for k, v in _gsets.items())
               + f"\necho SET selfplay\nnode tools/ai/dist/selfplay.mjs {_gargs} --out {GATE}/ts.bin\n{_rel}/ludo-selfplay {_gargs} --threads 20 --out {GATE}/rs.bin\n"
               f"cmp {GATE}/ts.bin {GATE}/rs.bin && echo SHARD identical $(stat -c %s {GATE}/rs.bin) bytes\n"
               f"echo SET bench\n{_rel}/ludo-bench-eval {NETS}/boot-all.json")
    tail(_job, 12)
    return


@app.cell(disabled=True)
def wandb_hashes(LOGS, SIMRS, WANDB_ENTITY, WANDB_PROJECT, json, sh, wandb):
    # feat/sim-rs was rewritten (commit metadata only; every tree is byte-identical). Runs logged before that
    # record Rust commits that no longer exist on the remote. This replaces each such hash in the W&B runs'
    # configs with the rewritten commit that has the same file tree, so every record points at a live commit.
    # The old hashes are read from the runs themselves and never written anywhere else. Runs once.
    import re
    _mark = LOGS / "wandb-hashes.done"
    if not _mark.exists():
        _new = {}
        for _line in sh(f"git -C {SIMRS} log origin/feat/sim-rs --format='%h %T'", check=False).splitlines():
            _h, _t = _line.split()
            _new.setdefault(_t, _h)
        _live = set(_new.values())
        _fixed = []
        for _run in wandb.Api().runs(f"{WANDB_ENTITY}/{WANDB_PROJECT}"):
            _changed = False
            for _k, _v in list(_run.config.items()):
                if not isinstance(_v, str):
                    continue
                _out = _v
                for _h in set(re.findall(r"\b[0-9a-f]{7}\b", _v)):
                    if _h in _live:
                        continue
                    _tree = sh(f"git -C {SIMRS} rev-parse --verify --quiet {_h}^{{tree}}", check=False).strip()
                    if _tree in _new:
                        _out = _out.replace(_h, _new[_tree])
                if _out != _v:
                    _run.config[_k] = _out
                    _changed = True
            if _changed:
                _run.update()
                _fixed.append(_run.name)
        _mark.write_text(json.dumps(_fixed))
    print("runs updated:", _mark.read_text())
    return


@app.cell
def gate2(
    DATA,
    LOGS,
    REPO,
    S2_HARD2T,
    S2_LADDER,
    SIMRS,
    launch,
    math,
    sh,
    sys,
    tail,
):
    # Session 2 gate, on FAIR dice (the user's rule: the engine trains and is measured with every face 1 in 6):
    # rule bots 50k games, nets at depth 1 (180 games, the gen-1 net and tuned Hard v2) traced by both
    # engines, and a fair self-play shard compared byte for byte. Plus nets at depth 1 on the app's dice, as
    # a regression check. Zero differences before Rust plays the ladder again. One folder per Rust commit.
    RUST_BIN = SIMRS / "sim-rs" / "target" / "release"
    _rc2 = sh(f"git -C {SIMRS} log -1 --format=%h")
    GATE2 = DATA / f"gate2-{_rc2}"
    GATE2.mkdir(parents=True, exist_ok=True)
    _g1net = S2_LADDER / "gen-1" / "net.json"
    _sets2 = {"fair-rules": (50_000, 51, "random,easy,normal,hard", "fair"),
              "fair-net1": (180, 52, f"net:{_g1net}:1,hard,net:{S2_HARD2T}:1:3:0.01,random", "fair"),
              "game-net1": (180, 53, f"net:{_g1net}:1,hard,net:{S2_HARD2T}:1:3:0.01,random", "game")}


    def _set_s2(name, n, seed, policies, dice, w=16):
        step = math.ceil(n / w)
        ts = "\n".join(f"node tools/ai/dist/trace.mjs --games {min(step, n - k * step)} --from {k * step} --seed {seed} --dice {dice} "
                       f"--policies {policies} --out {GATE2}/ts-{name}-{k}.jsonl &" for k in range(w) if k * step < n)
        return (f"echo SET {name}\n{ts}\nwait\ncat {GATE2}/ts-{name}-[0-9]*.jsonl > {GATE2}/ts-{name}.jsonl\n"
                f"{RUST_BIN}/ludo-trace --games {n} --seed {seed} --dice {dice} --policies {policies} --threads 16 --out {GATE2}/rs-{name}.jsonl\n"
                f"{sys.executable} tools/ai/trace_diff.py {GATE2}/ts-{name}.jsonl {GATE2}/rs-{name}.jsonl")


    _pool2 = f"net:{_g1net}:1:3:0.01:2,net:{S2_HARD2T}:1:3:0.01:1,hard:1,random:1"
    _args2 = f"--games 200 --seed 31 --keep 0.05 --dice fair --pool {_pool2} --commit gate"
    _job2 = f"gate2-{_rc2}"
    if not (LOGS / f"{_job2}.log").exists():
        launch(_job2, f"cd {REPO}\necho RUST {_rc2} CODE $(git log -1 --format=%h)\n" + "\n".join(_set_s2(k, *v) for k, v in _sets2.items())
               + f"\necho SET fair-selfplay\nnode tools/ai/dist/selfplay.mjs {_args2} --out {GATE2}/ts.bin\n{RUST_BIN}/ludo-selfplay {_args2} --threads 16 --out {GATE2}/rs.bin\n"
               f"cmp {GATE2}/ts.bin {GATE2}/rs.bin && echo SHARD identical $(stat -c %s {GATE2}/rs.bin) bytes")
    GATE2_OK = (LOGS / f"{_job2}.log").exists() and "SHARD identical" in (LOGS / f"{_job2}.log").read_text() \
        and (LOGS / f"{_job2}.log").read_text().count("mismatches 0 missing 0") == 3
    tail(_job2, 12)

    return GATE2_OK, RUST_BIN


@app.cell(disabled=True)
def grid2(
    DATA,
    GATE2_OK,
    LOGS,
    REPO,
    RUST_BIN,
    S2_HARD2T,
    S2_LADDER,
    launch,
    mo,
    score,
):
    # Faster self-play without losing strength, on fair dice: the gen-1 net at depth 1 with a cheaper search
    # (chance cap 1, and/or a probe cut of 1-2 win-chance points) against the full search (cap 2, cut 0),
    # 5k paired seeds each (seeds 40,000,000+), plus a 1,000-game self-play run per setting for games/s.
    # Pick the fastest setting within 1 point of the full search. Spec: net:<file>:depth:theirK:temp:race:chance:cut.
    _g1 = S2_LADDER / "gen-1" / "net.json"
    _full2 = f"net:{_g1}:1:3:0:0:2:0"
    GRID2 = {f"cap{c}-cut{x}": f"net:{_g1}:1:3:0:0:{c}:{x}" for c in (2, 1) for x in (0, 0.01, 0.02)}
    _jobs2 = []
    for _name, _spec in GRID2.items():
        _log = LOGS / f"arena-grid2-{_name}.log"
        if _log.exists():
            continue
        _sp = _spec.replace(":1:3:0:0:", ":1:3:0.006:0:")
        _arena = "" if _name == "cap2-cut0" else \
            f"{RUST_BIN}/ludo-arena --threads 16 --dice fair --a {_spec} --b {_full2} --mode 2p --from 40000000 --to 40005000\n"
        _jobs2.append(f"{{ echo START $(date -Is)\n{_arena}{RUST_BIN}/ludo-selfplay --games 1000 --seed 778 --dice fair "
                      f"--pool {_sp}:75,net:{S2_HARD2T}:1:15,hard:10 --keep 0.012 --threads 16 --out {DATA}/grid2-{_name}.bin\n"
                      f"echo END $(date -Is); }} > {_log} 2>&1")
    if not GATE2_OK:
        print("waiting for the session-2 gate (gate2)")
    elif _jobs2:
        launch("grid2", f"cd {REPO}\n" + "\n".join(_jobs2))


    def _row2(name):
        _log = LOGS / f"arena-grid2-{name}.log"
        if not _log.exists():
            return {"setting": name}
        _w = next((l for l in _log.read_text().splitlines() if l.startswith("DONE ")), "").split()
        _row = {"setting": name, "selfplay_games_per_s": float(_w[5]) if len(_w) > 5 else None,
                "cuts": _w[_w.index("cuts") + 1] if "cuts" in _w else ""}
        if name != "cap2-cut0":
            _row["win_vs_full"] = score(f"arena-grid2-{name}").get("win", "")
        return _row


    GRID2_ROWS = [_row2(n) for n in GRID2]
    mo.ui.table(GRID2_ROWS, selection=None)
    return


@app.cell(disabled=True)
def round1b(
    GATE2_OK,
    NETS,
    REPO,
    RUST_BIN,
    S2_HARD2T,
    S2_LADDER,
    json,
    launch,
    sys,
    tail,
):
    # Round 1 resumed (session 2): generation 2 on, on FAIR dice (the user's rule), from the promoted gen-1
    # net, against Hard v2 tuned. 200k games per generation (x1.25 per promotion, at most 400k), so more
    # generations fit before the 11:00 IST check; self-play uses the fastest search setting from grid2 within
    # 1 point of the full search (FAST below); the checks always use the full search. Same W&B run as gen 1.
    FAST = {"chance": 1, "cut": 0.01}  # from grid2 (fair dice, 5k paired seeds): 50.3% ± 0.6 vs the full search, 332 vs 124 games/s
    _st = json.loads((S2_LADDER / "state.json").read_text())
    if _st["gen"] == 1 and _st["games"] > 200_000:
        _st["games"] = 200_000  # session 2's per-generation size (the ladder reads it from its state)
        (S2_LADDER / "state.json").write_text(json.dumps(_st, indent=1))
    if not GATE2_OK:
        print("waiting for the session-2 gate (gate2)")
    else:
        launch("round1b", f"cd {REPO}\nexport LUDO_SELFPLAY='{RUST_BIN}/ludo-selfplay --threads 1' LUDO_ARENA='{RUST_BIN}/ludo-arena --threads 1'\n"
               f"{sys.executable} -u tools/ai/ladder.py --start {NETS}/boot-all.json --hard {S2_HARD2T} --dir {S2_LADDER} "
               f"--gens 30 --games 200000 --grow 1.25 --max-games 400000 --workers 16 --seeds 5000 --dice fair "
               f"--chance {FAST['chance']} --cut {FAST['cut']} --wandb ladder-r1")
    tail("round1b", 8)
    return


@app.cell(disabled=True)
def killtest(
    LOGS,
    NETS,
    REPO,
    RUST_BIN,
    S2_HARD2T,
    WORK,
    json,
    launch,
    os,
    subprocess,
    sys,
    tail,
    time,
):
    # Regression test for the W&B "run ID is in use" crash (cause: jobs shared the kernel's W&B service, which
    # kept a dead job's run open). A tiny ladder (2 workers, own dir, W&B run "killtest") is SIGKILLed mid-generation
    # and restarted at once; it passes when the first ladder is really dead and the restart resumes the SAME W&B run,
    # without the new-id fallback. (Run 1 of this test was void: pgrep read "--dir ..." as an option, nothing was killed.)
    import signal
    _kd = WORK / "killtest2"
    _cmd = (f"cd {REPO}\nexport LUDO_SELFPLAY='{RUST_BIN}/ludo-selfplay --threads 1' LUDO_ARENA='{RUST_BIN}/ludo-arena --threads 1'\n"
            f"{sys.executable} -u tools/ai/ladder.py --start {NETS}/boot-all.json --hard {S2_HARD2T} --dir {_kd} --gens 1 "
            f"--games 4000 --workers 2 --seeds 400 --dice fair --chance 1 --cut 0.01 --wandb killtest")


    def _wait_for(log, text, secs=240):
        _t = time.time()
        while time.time() - _t < secs:
            if log.exists() and text in log.read_text():
                return True
            time.sleep(2)
        return False


    def _kill_ladder(sig):
        for _pid in subprocess.run(["pgrep", "-f", "--", f"--dir {_kd} "], capture_output=True, text=True).stdout.split():
            try:
                os.kill(int(_pid), sig)
            except ProcessLookupError:
                pass


    def _alive():
        return subprocess.run(["pgrep", "-f", "--", f"--dir {_kd} "], capture_output=True).returncode == 0


    KILLTEST = {}
    if not (LOGS / "killtest-4.log").exists():
        _log1 = launch("killtest-3", _cmd)
        KILLTEST["first_started"] = _wait_for(_log1, "WANDB ")
        time.sleep(8)  # into the opening check / self-play
        _id1 = json.loads((_kd / "state.json").read_text())["wandb_id"]
        _kill_ladder(signal.SIGKILL)  # a crash: no wandb.finish(), no cleanup
        subprocess.run(["pkill", "-9", "-f", "--", f"{_kd}/"], check=False)  # its orphaned self-play workers
        time.sleep(2)
        KILLTEST["first_killed"] = not _alive()
        _log2 = launch("killtest-4", _cmd)  # restart at once, the case that failed before
        KILLTEST["second_started"] = _wait_for(_log2, "WANDB ")
        _id2 = json.loads((_kd / "state.json").read_text())["wandb_id"]
        _text2 = _log2.read_text()
        KILLTEST.update(same_run=_id1 == _id2, resumed="Resuming run" in _text2, in_use_error="in use" in _text2, run_id=_id2)
        _kill_ladder(signal.SIGTERM)  # test done: stop the tiny ladder
        subprocess.run(["pkill", "-f", "--", f"{_kd}/"], check=False)
        time.sleep(2)
        KILLTEST["stopped_after"] = not _alive()
        KILLTEST["passed"] = KILLTEST["first_killed"] and KILLTEST["second_started"] and KILLTEST["same_run"] and KILLTEST["resumed"] and not KILLTEST["in_use_error"]
        (LOGS / "killtest2.json").write_text(json.dumps(KILLTEST))
    else:
        KILLTEST = json.loads((LOGS / "killtest2.json").read_text())
    print(KILLTEST)
    tail("killtest-4", 6)
    return


@app.cell
def restore3(NETS, WANDB_ENTITY, WANDB_PROJECT, pathlib):
    # Session 3: box sb-558de0... stopped answering at about 23:55 UTC, mid generation 4 of round 1. Round 1's
    # promoted net after generation 3 (51.0% vs gen 1, 48.4% vs Hard v2 in 2p) is on W&B with its generation's
    # games and state (artifact ladder-r1-gen3-data); this restores the net. Round 1 ends here: self-play alone
    # had stalled at about 48% vs Hard v2. Round 2 (next cell) starts from this net.
    S3_GEN3 = NETS / "ladder-r1-gen3.json"
    if not S3_GEN3.exists():
        _a3 = __import__("wandb").Api().artifact(f"{WANDB_ENTITY}/{WANDB_PROJECT}/ladder-r1-gen3-data:latest")
        _d3 = pathlib.Path(_a3.download(root=str(NETS / "_art-ladder-r1-gen3-data"), path_prefix="net.json"))
        S3_GEN3.write_text((_d3 / "net.json").read_text())
    print(S3_GEN3, S3_GEN3.stat().st_size, "bytes")
    return (S3_GEN3,)


@app.cell(disabled=True)
def round2(
    GATE2_OK,
    REPO,
    RUST_BIN,
    S2_HARD2T,
    S3_GEN3,
    WORK,
    launch,
    sys,
    tail,
):
    # Round 2: self-play PLUS evolution (the user: "you need to do a mix"), on fair dice, checked in 4p.
    # The player is the Extreme blend: round 1's gen-3 net + alpha x Hard v2's readable rules (TKF's sweep, 2p,
    # 10k paired seeds: alpha 2 = 51.2%, CI 50.6-51.8, vs Hard v2). Each generation: play with the blend ->
    # train the net -> CMA-ES re-tunes the 25 rules and alpha around the new net (fitness: 4p win rate vs three
    # Hard v2 houses) -> check. Before the first game it evolves once around the gen-3 net (generation 0).
    # 4p checks (the user's call, the app's real games are 4 houses): the tested engine in one house, the
    # baseline in the other three, each seed played from every house; equal strength = 25%.
    # The net trains as a residual over the frozen rules with one learned temperature (TKF, train.py
    # --rules --alpha --learn-temp: calibration error 0.171 -> 0.022), so net and rules do not count the same
    # knowledge twice; evolution starts each generation from the trainer's tau * alpha.
    # From generation 2: lambda-return targets (TKF's lambda line was promoted at 50.0% vs Hard v2 in 2p where the
    # outcome line stalled at 48.4%), valued as the blend plays (ludo-label --eval blend:..., Rust 6d911f1), once
    # TKF's label gate passes; until then outcome labels.
    R2_MODES, R2_POOL = "4p", "45,10,40,5"  # from generation 4: the target's games (4p vs Hard v2); before: every mode, 60,15,15,10
    R2_LABELS = "lambda"  # from generation 3 (TKF label gate passed); generations 1-2 used outcome labels
    ALPHA0 = 2.0  # TKF's best alpha so far (the curve was still rising; evolution moves it from here)
    S3_LADDER = WORK / "ladder-r2"
    # Self-play search from grid2 (cap 1, cut 0.01: 50.3% +- 0.6 vs the full search, 2.7x faster). Not round1b's
    # FAST: referencing it would make lazy mode re-run round1b, i.e. relaunch round 1.
    _fast = {"chance": 1, "cut": 0.01}
    if not GATE2_OK:
        print("waiting for the gate (gate2)")
    else:
        launch("round2", f"cd {REPO}\nexport LUDO_SELFPLAY='{RUST_BIN}/ludo-selfplay --threads 1' LUDO_ARENA='{RUST_BIN}/ludo-arena --threads 1' LUDO_LABEL='{RUST_BIN}/ludo-label'\n"
               f"{sys.executable} -u tools/ai/ladder.py --start {S3_GEN3} --hard {S2_HARD2T} --dir {S3_LADDER} "
               f"--gens 30 --games 200000 --grow 1.25 --max-games 400000 --workers 16 --seeds 2500 --dice fair "
               f"--chance {_fast['chance']} --cut {_fast['cut']} --seed-base 700000 "
               f"--blend {S2_HARD2T} --alpha {ALPHA0} --residual --learn-temp --labels {R2_LABELS} --modes {R2_MODES} --pool-weights {R2_POOL} --check-mode 4p --evolve-gens 8 --evolve-pop 10 --evolve-seeds 800 --wandb ladder-r2")
    tail("round2", 8)
    return


@app.cell(disabled=True)
def round2_swap(LOGS, WORK, json, running, subprocess, time):
    # Round 2 at a generation boundary: stop the ladder so the code pin (cell code) can move, then re-run
    # round2, which resumes from its state file (kill-and-resume is tested: cell killtest). Used after generation 1
    # to move to 3836dd5: evolution keeps the final CMA-ES mean or the start (whichever wins a held-out block)
    # instead of the best noisy generation, with 800 seeds per candidate (gen 0: best 29.3% on its block, 25.9%
    # in the 2,500-seed check). The next generation's shards are deleted, so no half-written shard is kept.
    # One-shot per SWAP_TAG (a marker file), so a lazy re-run of this cell never stops the ladder again.
    import signal
    _r2 = WORK / "ladder-r2"  # not round2's S3_LADDER: referencing it would make lazy mode run round2 first
    _st2 = json.loads((_r2 / "state.json").read_text())
    SWAP_AT = 3  # stop after this generation (gen1: 3836dd5, final-mean evolution; gen2: 79a4d84 + Rust 6d911f1, lambda
    # labels, saves after play; lambda-window, also after gen 2: 4448dfa, the lambda window skips outcome-only generations;
    # best-response, after gen 3: b6527a2, 4p-only self-play with Hard v2 in 40% of seats, the games the target measures;
    # stop-for-expertB, during gen 4's labelling (its games are on W&B): round 2 ends here (best: gen 2, 27.39% vs Hard v2)
    # and the box makes arm-B expert data; the round2 cell is disabled so nothing relaunches it)
    SWAP_TAG = "stop-for-expertB"  # one marker per swap (gen1, gen2: earlier swaps at these generations)
    _mark = LOGS / f"round2-swap-{SWAP_TAG}.done"
    SWAP_R2 = {"gen_done": _st2["gen"], "already": _mark.exists()}
    if not _mark.exists() and _st2["gen"] >= SWAP_AT and running("round2"):
        for _pat in (f"--dir {_r2} ", f"{_r2}/"):
            subprocess.run(["pkill", "-f", "--", _pat], check=False)
        time.sleep(3)
        for _f in (_r2 / f"gen-{_st2['gen'] + 1}").glob("shard-*.bin"):
            _f.unlink()
        SWAP_R2["stopped"] = not running("round2")
        _mark.write_text("")
    print(SWAP_R2)
    return


@app.cell(disabled=True)
def persist_r2(LOGS, WANDB_ENTITY, WANDB_PROJECT, WORK):
    # Off the box: round 2's generation-0 evolution (the rules and alpha every later generation starts from) was
    # only on this disk. The ladder saves each played generation as <wandb>-gen<k>-data, but gen 0 has no games,
    # so it was never saved; this logs it as ladder-r2-gen0-data (rules, blend, state). One-shot per file set.
    _g0 = WORK / "ladder-r2" / "gen-0"
    _m0 = LOGS / "persist-r2-gen0.done"
    if (_g0 / "evolve.done").exists() and not _m0.exists():
        import wandb as _wbp
        _run = _wbp.init(entity=WANDB_ENTITY, project=WANDB_PROJECT, name="ladder-r2-gen0-persist", group="ladder", job_type="persist")
        _art = _wbp.Artifact("ladder-r2-gen0-data", type="generation", metadata={"note": "gen-0 evolution of round 2 (no games)"})
        for _f in ("rules.json", "rules.json.blend.json"):
            _art.add_file(str(_g0 / _f), name=_f)
        _art.add_file(str(WORK / "ladder-r2" / "state.json"), name="state.json")
        _run.log_artifact(_art)
        _run.finish()
        _m0.write_text("")
    print("gen-0 saved:", _m0.exists())
    return


@app.cell
def heartbeat(BRANCH, LOGS, REPO, launch, sh, sys, tail):
    # Why do molab boxes die? Four died tonight (two of mine, one of TKF's, and sb-558 was swapped for a fresh
    # sandbox mid-ladder). Hypotheses: (1) the GPU sits idle (our self-play is CPU-only; the GPU trains ~30 s per
    # generation) and molab reclaims idle GPU boxes, which the user saw once ("went idle due to inactivity of GPU");
    # (2) no notebook tab open (TKF); (3) overload (unlikely: the quota is 20 cores, we use <= 16 under nice).
    # This heartbeat logs the box's vital signs to W&B every minute (run heartbeat-<host>, group boxes), so the
    # next death leaves its last minutes behind. The script comes from a fixed commit, without moving the code pin.
    HEARTBEAT_COMMIT = "79a4d84"
    _hb = LOGS / "heartbeat.py"
    if not _hb.exists():
        sh(f"git -C {REPO} fetch -q origin {BRANCH} && git -C {REPO} show {HEARTBEAT_COMMIT}:tools/ai/heartbeat.py > {_hb}")
    launch("heartbeat", f"{sys.executable} -u {_hb} --every 60")
    tail("heartbeat", 3)

    return


@app.cell(disabled=True)
def calib4p(LOGS, RUST_BIN, S2_HARD2T, json, launch, math, mo):
    # How big is a 4p win rate? The user's finish line: Extreme in one house vs Hard v2 in the other three, win
    # rate 40-45% (equal = 25%). To read that, known skill gaps in 4p: Hard v2 vs 3x the old Hard (in 2p Hard v2
    # wins 70.9%), the old Hard vs 3x Normal, Normal vs 3x Easy, and each vs 3x Random. Fair dice, 5k seeds x 4
    # houses, 2 threads beside the ladder (rule bots are cheap).
    _h2 = f"net:{S2_HARD2T}:1"
    CALIB = {"hard2 vs 3 hard": (_h2, "hard"), "hard vs 3 normal": ("hard", "normal"), "normal vs 3 easy": ("normal", "easy"),
             "hard2 vs 3 random": (_h2, "random"), "hard vs 3 random": ("hard", "random")}
    _cj = []
    for _n, (_a, _b) in CALIB.items():
        _lg = LOGS / f"calib4p-{_n.replace(' ', '_')}.log"
        if not _lg.exists():
            _cj.append(f"{RUST_BIN}/ludo-arena --threads 2 --dice fair --a {_a} --b {_b} --mode 4p --from 60000000 --to 60005000 > {_lg} 2>&1")
    if _cj:
        launch("calib4p", "\n".join(_cj))


    def _calrow(name):
        _lg = LOGS / f"calib4p-{name.replace(' ', '_')}.log"
        _t = _lg.read_text() if _lg.exists() else ""
        if "ARENA " not in _t:
            return {"match": name, "win": ""}
        _r = json.loads(_t.split("ARENA ", 1)[1])
        _m = _r["wins"] / _r["seeds"]
        _se = math.sqrt(max(0.0, _r["seedSq"] / _r["seeds"] - _m * _m) / _r["seeds"]) / _r["people"]
        return {"match": name, "win": f"{_r['wins'] / _r['games']:.4f}", "ci95": f"{1.96 * _se:.4f}", "games": _r["games"]}


    CALIB_ROWS = [_calrow(n) for n in CALIB]
    mo.ui.table(CALIB_ROWS, selection=None)
    return


@app.cell(disabled=True)
def expertB(
    GATE2_OK,
    LOGS,
    NETS,
    REPO,
    RUST_BIN,
    S2_HARD2T,
    WANDB_ENTITY,
    WANDB_PROJECT,
    WORK,
    launch,
    pathlib,
    sys,
    tail,
):
    # Expert data, arm B (breadth): the finish line is 40-45% in 4p vs three Hard v2 houses. TKF's rollout player
    # reaches 37% (256 paired playouts per move), but a net trained on game outcomes cannot see the ~0.01 gaps between
    # moves through the dice noise (V^hard2 net: 25.97%). The signal has to be PAIRED: every candidate move played out
    # with the same dice, per seat, so the luck cancels within a decision. Arm A (TKF's box): 256 playouts at ~130k
    # decisions. Arm B (here): the same compute spread wide, 4 playouts at millions of decisions, every seat's decisions
    # logged (--all-seats). TKF's train.py --expert fits the centred pair loss on both. Rust ce541af (ludo-expert).
    # Playouts: Hard v2 for every seat, cut after 12 turns and scored by the lambda gen-3 net (the ceiling run's setup).
    # Each chunk is uploaded at once as a new version of W&B artifact expertB-4p (all chunks so far; W&B stores each
    # file once), so a box death costs at most one chunk.
    _lam3 = NETS / "ladder-r1-lambda-gen3.json"
    if not _lam3.exists():
        _al3 = __import__("wandb").Api().artifact(f"{WANDB_ENTITY}/{WANDB_PROJECT}/ladder-r1-lambda-gen3:latest")
        _dl3 = pathlib.Path(_al3.download(root=str(NETS / "_art-ladder-r1-lambda-gen3")))
        _lam3.write_text(next(p for p in _dl3.iterdir() if p.suffix == ".json").read_text())
    EXPERTB = WORK / "expertB"
    EXPERTB.mkdir(exist_ok=True)
    _up = LOGS / "expertB_upload.py"
    _up.write_text(
        "import sys, pathlib, wandb\n"
        "d = pathlib.Path(sys.argv[1])\n"
        f"run = wandb.init(entity='{WANDB_ENTITY}', project='{WANDB_PROJECT}', name='expertB-upload', group='expert', job_type='data')\n"
        "art = wandb.Artifact('expertB-4p', type='expert', metadata={'arm': 'B', 'n': 4, 'cut': 12})\n"
        "for f in sorted(d.glob('expertB-*.bin')):\n"
        "    art.add_file(str(f))\n"
        "run.log_artifact(art)\n"
        "run.finish()\n")
    _spec = f"rollout:4:12:{_lam3}:net:{S2_HARD2T}:1"
    _chunks = "\n".join(
        f"[ -f {EXPERTB}/expertB-{c}.bin ] || {{ {RUST_BIN}/ludo-expert --expert {_spec} --opp net:{S2_HARD2T}:1 --games 1000 "
        f"--seed {900 + c} --all-seats 1 --threads 16 --modes 4p --out {EXPERTB}/expertB-{c}.bin.tmp && mv {EXPERTB}/expertB-{c}.bin.tmp {EXPERTB}/expertB-{c}.bin "
        f"&& {sys.executable} {_up} {EXPERTB}; }}" for c in range(4))
    if not GATE2_OK:
        print("waiting for the gate (gate2) on the pinned Rust commit")
    else:
        launch("expertB", f"cd {REPO}\n{_chunks}\nls -la {EXPERTB}")
    tail("expertB", 6)
    return


@app.cell(disabled=True)
def expertC(
    GATE2_OK,
    LOGS,
    NETS,
    REPO,
    RUST_BIN,
    S2_HARD2T,
    WANDB_ENTITY,
    WANDB_PROJECT,
    WORK,
    launch,
    running,
    sys,
    tail,
):
    # Expert data, arm C: arm B's setup with 16 paired playouts per candidate instead of 4 (4x less noise per decision,
    # same rows), a middle point between A (256, few decisions) and B (4, many). Starts after arm B (one heavy job).
    # Uploads like arm B: each chunk at once, as a new version of W&B artifact expertC-4p.
    _lam3c = NETS / "ladder-r1-lambda-gen3.json"  # restored by cell expertB
    EXPERTC = WORK / "expertC"
    EXPERTC.mkdir(exist_ok=True)
    _upc = LOGS / "expertC_upload.py"
    _upc.write_text(
        "import sys, pathlib, wandb\n"
        "d = pathlib.Path(sys.argv[1])\n"
        f"run = wandb.init(entity='{WANDB_ENTITY}', project='{WANDB_PROJECT}', name='expertC-upload', group='expert', job_type='data')\n"
        "art = wandb.Artifact('expertC-4p', type='expert', metadata={'arm': 'C', 'n': 16, 'cut': 12})\n"
        "for f in sorted(d.glob('expertC-*.bin')):\n"
        "    art.add_file(str(f))\n"
        "run.log_artifact(art)\n"
        "run.finish()\n")
    _specc = f"rollout:16:12:{_lam3c}:net:{S2_HARD2T}:1"
    _chunksc = "\n".join(
        f"[ -f {EXPERTC}/expertC-{c}.bin ] || {{ {RUST_BIN}/ludo-expert --expert {_specc} --opp net:{S2_HARD2T}:1 --games 1000 "
        f"--seed {910 + c} --all-seats 1 --threads 16 --modes 4p --out {EXPERTC}/expertC-{c}.bin.tmp && mv {EXPERTC}/expertC-{c}.bin.tmp {EXPERTC}/expertC-{c}.bin "
        f"&& {sys.executable} {_upc} {EXPERTC}; }}" for c in range(4))
    if not GATE2_OK:
        print("waiting for the gate (gate2) on the pinned Rust commit")
    elif running("expertB"):
        print("arm B still runs (one heavy job at a time)")
    else:
        launch("expertC", f"cd {REPO}\n{_chunksc}\nls -la {EXPERTC}")
    tail("expertC", 6)
    return


@app.cell(disabled=True)
def expertA2(
    GATE2_OK,
    LOGS,
    NETS,
    REPO,
    RUST_BIN,
    S2_HARD2T,
    WANDB_ENTITY,
    WANDB_PROJECT,
    WORK,
    launch,
    pathlib,
    running,
    sys,
    tail,
):
    # Expert iteration, round 2 (second box): the paired-rollout expert again, but its playouts' 12-turn leaves are now
    # scored by iteration 1's net (expert-it1: lambda gen 3 + arm A/B expert data, 28.6% vs 3x Hard v2 in 4p, up
    # from 26.2%), so the expert is sharper and its data teaches the next net more: AlphaZero-style expert iteration.
    # Arm-A shape (256 paired playouts per candidate, the expert's own decisions), on both boxes with distinct seeds
    # (TKF's box and this one), merged for training. Each chunk uploads at once to W&B artifact expertA2-4p-box2.
    IT1_ART = "expert-it1:v0"  # TKF's iteration-1 net (28.58 +- 0.73 vs 3x Hard v2, 1k seeds); both boxes use v0, so the data merges
    _it1 = NETS / "expert-it1.json"
    if IT1_ART and not _it1.exists():
        _ai1 = __import__("wandb").Api().artifact(f"{WANDB_ENTITY}/{WANDB_PROJECT}/{IT1_ART}")
        _di1 = pathlib.Path(_ai1.download(root=str(NETS / "_art-expert-it1-v0")))
        _it1.write_text(next(p for p in _di1.iterdir() if p.suffix == ".json").read_text())
    EXPERTA2 = WORK / "expertA2"
    EXPERTA2.mkdir(exist_ok=True)
    _upa2 = LOGS / "expertA2_upload.py"
    _upa2.write_text(
        "import sys, pathlib, wandb\n"
        "d = pathlib.Path(sys.argv[1])\n"
        f"run = wandb.init(entity='{WANDB_ENTITY}', project='{WANDB_PROJECT}', name='expertA2-upload', group='expert', job_type='data')\n"
        "art = wandb.Artifact('expertA2-4p-box2', type='expert', metadata={'iteration': 2, 'n': 256, 'cut': 12, 'leaf': 'expert-it1'})\n"
        "for f in sorted(d.glob('expertA2-box2-*.bin')):\n"
        "    art.add_file(str(f))\n"
        "run.log_artifact(art)\n"
        "run.finish()\n")
    _speca2 = f"rollout:256:12:{_it1}:net:{S2_HARD2T}:1"
    _chunksa2 = "\n".join(
        f"[ -f {EXPERTA2}/expertA2-box2-{c}.bin ] || {{ {RUST_BIN}/ludo-expert --expert {_speca2} --opp net:{S2_HARD2T}:1 --games 450 "
        f"--seed {920 + c} --threads 16 --modes 4p --out {EXPERTA2}/expertA2-box2-{c}.bin.tmp && mv {EXPERTA2}/expertA2-box2-{c}.bin.tmp {EXPERTA2}/expertA2-box2-{c}.bin "
        f"&& {sys.executable} {_upa2} {EXPERTA2}; }}" for c in range(4))
    if not (IT1_ART and GATE2_OK):
        print("waiting for TKF's iteration-1 net (IT1_ART) and the gate")
    elif running("expertC"):
        print("arm C still runs (one heavy job at a time)")
    else:
        launch("expertA2", f"cd {REPO}\n{_chunksa2}\nls -la {EXPERTA2}")
    tail("expertA2", 6)

    return


@app.cell
def expertA1b(
    GATE2_OK,
    LOGS,
    NETS,
    REPO,
    RUST_BIN,
    S2_HARD2T,
    WANDB_ENTITY,
    WANDB_PROJECT,
    WORK,
    launch,
    pathlib,
    running,
    sys,
    tail,
):
    # Expert data, arm A again (more of what worked): iteration 1's +2.4 pts (26.2 -> 28.58% vs 3x Hard v2 in 4p) came
    # from only 450 games of the paired-rollout expert built on the lambda gen-3 net (256 playouts per candidate, cut 12);
    # TKF's chunks 1-3 of that data were lost with a box. Iteration 2 (expert built on it1's own leaves) played 1.4 pts
    # worse: it amplified it1's errors. So this box makes more arm-A data (leaf = lambda gen 3, seeds 930+), for a
    # bigger iteration-1 net. Each chunk uploads at once to W&B artifact expertA-4p-box2.
    LAM3_ART = "ladder-r1-lambda-gen3:latest"  # the leaf evaluator of arm A (TKF's lambda line, gen 3)
    _lam3a = NETS / "ladder-r1-lambda-gen3.json"
    if not _lam3a.exists():
        _ala = __import__("wandb").Api().artifact(f"{WANDB_ENTITY}/{WANDB_PROJECT}/{LAM3_ART}")
        _dla = pathlib.Path(_ala.download(root=str(NETS / "_art-ladder-r1-lambda-gen3")))
        _lam3a.write_text(next(p for p in _dla.iterdir() if p.suffix == ".json").read_text())
    EXPERTA1B = WORK / "expertA1b"
    EXPERTA1B.mkdir(exist_ok=True)
    _upa1b = LOGS / "expertA1b_upload.py"
    _upa1b.write_text(
        "import sys, pathlib, wandb\n"
        "d = pathlib.Path(sys.argv[1])\n"
        f"run = wandb.init(entity='{WANDB_ENTITY}', project='{WANDB_PROJECT}', name='expertA1b-upload', group='expert', job_type='data')\n"
        "art = wandb.Artifact('expertA-4p-box2', type='expert', metadata={'arm': 'A', 'n': 256, 'cut': 12, 'leaf': 'ladder-r1-lambda-gen3'})\n"
        "for f in sorted(d.glob('expertA-box2-*.bin')):\n"
        "    art.add_file(str(f))\n"
        "run.log_artifact(art)\n"
        "run.finish()\n")
    _speca1b = f"rollout:256:12:{_lam3a}:net:{S2_HARD2T}:1"
    _chunksa1b = "\n".join(
        f"[ -f {EXPERTA1B}/expertA-box2-{c}.bin ] || {{ {RUST_BIN}/ludo-expert --expert {_speca1b} --opp net:{S2_HARD2T}:1 --games 450 "
        f"--seed {930 + c} --threads 16 --modes 4p --out {EXPERTA1B}/expertA-box2-{c}.bin.tmp && mv {EXPERTA1B}/expertA-box2-{c}.bin.tmp {EXPERTA1B}/expertA-box2-{c}.bin "
        f"&& {sys.executable} {_upa1b} {EXPERTA1B}; }}" for c in range(4))
    if not GATE2_OK:
        print("waiting for the gate (gate2)")
    elif running("expertA2"):
        print("iteration-2 data still runs (one heavy job at a time)")
    else:
        launch("expertA1b", f"cd {REPO}\n{_chunksa1b}\nls -la {EXPERTA1B}")
    tail("expertA1b", 6)

    return


if __name__ == "__main__":
    app.run()
