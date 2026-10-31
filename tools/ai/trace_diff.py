"""Compares a port's parity traces with the TypeScript engine's (tools/ai/trace.ts).

    python trace_diff.py reference.jsonl candidate.jsonl [--show 5]

Games are matched by `g`. Reports mismatching hashes by mode and policy; for games with full traces on
both sides, prints the first step that differs. Exits non-zero on any mismatch or missing game.
"""
import argparse, collections, json, sys


def read(path):
    with open(path, encoding='utf-8') as f:
        return {(x := json.loads(line))['g']: x for line in f if line.strip()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('reference')
    ap.add_argument('candidate')
    ap.add_argument('--show', type=int, default=5, help='first differing steps to print')
    a = ap.parse_args()
    ref, cand = read(a.reference), read(a.candidate)
    missing = sorted(set(ref) - set(cand))
    bad = [g for g in sorted(set(ref) & set(cand)) if ref[g]['hash'] != cand[g]['hash'] or ref[g]['ranking'] != cand[g]['ranking']]
    by = collections.Counter((ref[g]['mode'], '/'.join(ref[g]['policies'])) for g in bad)
    print(f'DIFF games {len(ref)} compared {len(set(ref) & set(cand))} mismatches {len(bad)} missing {len(missing)}')
    for (mode, pol), n in by.most_common(20):
        print(f'  {n:6d}  {mode:22s} {pol}')
    shown = 0
    for g in bad:
        r, c = ref[g].get('trace'), cand[g].get('trace')
        if not r or not c or shown >= a.show:
            continue
        k = next((i for i, (x, y) in enumerate(zip(r, c)) if x != y), min(len(r), len(c)))
        if k == len(r) == len(c):
            print(f'game {g}: every step agrees, but the hash or ranking differs (check the hash code)')
            shown += 1
            continue
        print(f'game {g} ({ref[g]["mode"]}, {ref[g]["policies"]}): first difference at step {k}')
        print(f'  before: {r[k - 1] if k else "(start)"}')
        print(f'  ts:     {r[k] if k < len(r) else "(ended)"}')
        print(f'  port:   {c[k] if k < len(c) else "(ended)"}')
        shown += 1
    sys.exit(1 if bad or missing else 0)


if __name__ == '__main__':
    main()
