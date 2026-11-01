"""Box heartbeat: the vital signs of a training box, every minute, to W&B (they outlive the box).

    python heartbeat.py [--every 60] [--name heartbeat-<box>]

Logs uptime, CPU busy % (from /proc/stat), memory used, GPU use and memory (nvidia-smi), the number of
established connections to the notebook server (port 8080: browser tabs and execute-code calls), and the
number of ladder / tune / self-play / arena / label processes. When a box dies, the run's last rows show
what led up to it: GPU idle for how long, a tab open or not, the load. To find why molab boxes die.
"""
import argparse, os, socket, subprocess, time


def cpu_times():
    with open('/proc/stat') as f:
        v = list(map(int, f.readline().split()[1:]))
    return sum(v), v[3] + v[4]  # total, idle + iowait


def connections(port=8080):
    n = 0
    for table in ('/proc/net/tcp', '/proc/net/tcp6'):
        try:
            with open(table) as f:
                for line in f.readlines()[1:]:
                    parts = line.split()
                    if parts[3] == '01' and int(parts[1].rsplit(':', 1)[1], 16) == port:  # ESTABLISHED, local port
                        n += 1
        except OSError:
            pass
    return n


def gpu():
    try:
        out = subprocess.run(['nvidia-smi', '--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits'],
                             capture_output=True, text=True, timeout=20).stdout.split(',')
        return float(out[0]), float(out[1])
    except Exception:
        return -1.0, -1.0


def jobs():
    out = subprocess.run(['ps', '-eo', 'stat,args'], capture_output=True, text=True).stdout.splitlines()[1:]
    live = [l.split(None, 1)[1] for l in out if not l.startswith('Z') and len(l.split(None, 1)) > 1]
    return {k: sum(k in a for a in live) for k in ('ladder.py', 'tune.py', 'train.py', 'ludo-selfplay', 'ludo-arena', 'ludo-label')}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--every', type=int, default=60)
    ap.add_argument('--name', default=f'heartbeat-{socket.gethostname()}')
    a = ap.parse_args()
    import wandb
    run = wandb.init(entity=os.environ.get('LUDO_WANDB_ENTITY', 'ablations-tinycompany-ai'), project='tag-team-ludo-ai',
                     name=a.name, group='boxes', job_type='heartbeat')
    print(f'WANDB {run.url}', flush=True)
    t0, i0 = cpu_times()
    while True:
        time.sleep(a.every)
        t1, i1 = cpu_times()
        busy = 100 * (1 - (i1 - i0) / max(1, t1 - t0))
        t0, i0 = t1, i1
        with open('/proc/uptime') as f:
            up = float(f.read().split()[0])
        with open('/proc/meminfo') as f:
            mem = {l.split(':')[0]: int(l.split()[1]) for l in f}
        g, gm = gpu()
        row = {'box/uptime_min': up / 60, 'box/cpu_busy_pct': busy, 'box/mem_used_gb': (mem['MemTotal'] - mem['MemAvailable']) / 2**20,
               'box/gpu_util_pct': g, 'box/gpu_mem_mb': gm, 'box/notebook_connections': connections()}
        row |= {f'jobs/{k}': v for k, v in jobs().items()}
        run.log(row)
        print('BEAT ' + ' '.join(f'{k.split("/")[1]}={v:.1f}' if isinstance(v, float) else f'{k.split("/")[1]}={v}' for k, v in row.items()), flush=True)


if __name__ == '__main__':
    main()
