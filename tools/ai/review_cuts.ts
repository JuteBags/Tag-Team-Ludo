// #138: how would stricter label cuts read, and how steady would they be? On the REVIEW_CALIB games
// (review_calib's generator: seat 0's person at --mover, every other seat Hard, the app's dice), every
// decision of seat 0 is reviewed by the full review (sim-rs rollout.rs review, no early stop):
//   - at --ref playouts (1,024) per move: the reference;
//   - at 128, 256 and 512, with 3 seeds each: what a review at that many playouts would say.
// Each is labelled with every cut set (A the owner's, B between, C today's), plain and with the two rules
// under discussion: "clear the cut by one se" (the harsher label only when gap - se reaches its cut) and the
// turning point (best leaves you at 50% or more, your move under 50%: one step harsher). Writes
// decisions.jsonl (every decision's gap, se and chances at every count and seed), so the report job can
// join the layouts.
//   node tools/ai/dist/review_cuts.mjs --task eval --layout 2p --mover hard [--games 5] [--from 1] [--ref 1024]
//   node tools/ai/dist/review_cuts.mjs --task report <dirs...>
// .github/workflows/review-study.yml runs it (heavy: never on the laptop).
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGame, move, roll, seededDie, seeded, type BotLevel, type GameRecord, type GameState, type Seat } from '../../src/engine';
import { chooseBotMove } from '../../src/engine/ai/levels';
import { PLAYOUT_RULES } from '../../src/engine/ai/playout-rules';
import { layoutKey, THRESHOLDS_BY_LAYOUT, type Label } from '../../src/engine/ai/review';
import { RolloutEngine } from '../../src/engine/ai/rollout';
import { replay } from '../../src/engine/record';
import { flags, MODES } from './common';

const argv = process.argv.slice(2);
const a = flags(argv);
const task = a.task ?? 'eval';
const summary = process.env.GITHUB_STEP_SUMMARY;
const md = (line: string) => {
  console.log(line);
  if (summary) appendFileSync(summary, line + '\n');
};
const NS = (a.ns ?? '128,256,512').split(',').map(Number);
const SEEDS = [1, 2, 3];

/** A move's numbers from one full review: its gap below the best and se (points), its chance and the best's (%). */
interface Look {
  gap: number;
  se: number;
  mine: number;
  best: number;
}
interface Row {
  layout: string;
  mover: string;
  game: number;
  at: number;
  ref: Look;
  /** looks[n][seed index] */
  looks: Record<string, Look[]>;
  /** milliseconds of the full review at each count, this decision */
  ms: Record<string, number>;
}

/** Cut sets in points (2p; other layouts scaled as today: THRESHOLDS_BY_LAYOUT). `tops`: each label's upper end. */
interface Cuts {
  name: string;
  best: number;
  tops: [Label, number][];
  /** No scaled cut under this (today's CUT_FLOOR is 1; the stricter sets need none). */
  floor: number;
}
const SETS: Cuts[] = [
  { name: 'A (owner)', best: 0.5, tops: [['inaccuracy', 1], ['mistake', 2]], floor: 0 },
  { name: 'B (between)', best: 1, tops: [['good', 1.5], ['inaccuracy', 3], ['mistake', 6]], floor: 0 },
  { name: 'C (today)', best: 1.5, tops: [['good', 2], ['inaccuracy', 5], ['mistake', 10]], floor: 1 },
];
const LADDER: Label[] = ['best', 'good', 'inaccuracy', 'mistake', 'blunder'];

/** The label of `l` under `cuts` in `layout`; `se` rule: harsher only when gap - se reaches the cut; `tp`: the turning point. */
function label(l: Look, cuts: Cuts, layout: string, rules: { se: boolean; tp: boolean }): Label {
  const f = THRESHOLDS_BY_LAYOUT[layout] ?? 1;
  const c = (x: number) => Math.max(cuts.floor, x * f);
  const g = rules.se ? l.gap - l.se : l.gap;
  let out: Label = 'blunder';
  if (l.gap <= c(cuts.best) || l.gap <= l.se || (rules.se && g <= c(cuts.best))) out = 'best';
  else {
    for (const [lab, top] of cuts.tops)
      if (g < c(top)) {
        out = lab;
        break;
      }
  }
  if (rules.tp && out !== 'blunder' && l.best >= 50 && l.mine < 50) {
    // one step harsher on this set's own ladder
    const used = new Set<Label>(['best', ...cuts.tops.map(([x]) => x), 'blunder']);
    const ladder = LADDER.filter((x) => used.has(x));
    out = ladder[Math.min(ladder.length - 1, ladder.indexOf(out) + 1)]!;
  }
  return out;
}
const SCORE: Record<Label, number> = { best: 1, good: 0.9, inaccuracy: 0.6, mistake: 0.3, blunder: 0 };
const VARIANTS: { name: string; se: boolean; tp: boolean }[] = [
  { name: 'plain', se: false, tp: false },
  { name: '+ se rule', se: true, tp: false },
  { name: '+ se rule + turning point', se: true, tp: true },
];

if (task === 'eval') {
  const layout = a.layout ?? '2p';
  const mover = (a.mover ?? 'hard') as BotLevel;
  const games = Number(a.games ?? 5);
  const from = Number(a.from ?? 1);
  const refN = Number(a.ref ?? 1024);
  const root = new URL('../../../', import.meta.url);
  const engine = await RolloutEngine.create(readFileSync(new URL('src/engine/ai/ludo_wasm.wasm', root)), new Uint8Array(readFileSync(new URL('src/engine/ai/extreme-net.bin', root))), PLAYOUT_RULES);
  /** review_calib's game. */
  const game = (seed: number): GameRecord => {
    const seats: Seat[] = MODES[layout]!.seats().map((s) => ({ ...s, bot: true, level: s.owner === 0 ? mover : 'hard' }));
    const rng = seeded(seed * 31 + 7);
    let s = createGame(seats, seats[seed % seats.length]!.color, MODES[layout]!.singles);
    let events = '';
    for (let n = 0; s.phase !== 'over' && n < 20000; n++) {
      if (s.phase === 'roll') {
        const f = seededDie(seed, s);
        events += String(f);
        s = roll(s, () => 0, f);
      } else {
        const m = chooseBotMove(s, rng);
        events += (m.tokens.length === 1 ? 'abcd'[m.tokens[0]!] : 'efghij'[['01', '02', '03', '12', '13', '23'].indexOf([...m.tokens].sort().join(''))]!) + m.roll;
        s = move(s, m);
      }
    }
    return { v: 1, seats, first: seats[seed % seats.length]!.color, singles: MODES[layout]!.singles || undefined, seed, events };
  };
  const look = (s: GameState, played: number, n: number, seed: number): [Look, number] => {
    const t = performance.now();
    const v = engine.review(s, n, seed);
    const c = v.ofMove[played]!;
    const mine = c === v.best;
    return [{ gap: mine ? 0 : 100 * v.gap[c]!, se: mine ? 0 : 100 * v.se[c]!, mine: 100 * v.mean[c]!, best: 100 * v.mean[v.best]! }, performance.now() - t];
  };
  writeFileSync('decisions.jsonl', '');
  for (let g = from; g < from + games; g++) {
    const rec = game(g);
    const states = replay(rec).states as GameState[];
    const key = layoutKey(states[0]!);
    for (let i = 0; i + 1 < states.length; i++) {
      const s = states[i]!;
      if (s.phase !== 'move' || s.players[s.current]!.owner !== 0 || s.moves.length < 2) continue;
      const ev = states[i + 1]!.event;
      if (ev?.type !== 'moved') continue;
      const played = s.moves.findIndex((m) => JSON.stringify(m) === JSON.stringify(ev.move));
      // Every move reaching the same position isn't a choice: the app skips it, and so does this.
      if (engine.review(s, 1, 1).mean.length < 2) continue;
      const [ref, refMs] = look(s, played, refN, 9001);
      const looks: Record<string, Look[]> = {};
      const ms: Record<string, number> = { [refN]: refMs };
      for (const n of NS) {
        looks[n] = [];
        ms[n] = 0;
        for (const seed of SEEDS) {
          const [l, t] = look(s, played, n, seed * 101 + n);
          looks[n]!.push(l);
          ms[n]! += t / SEEDS.length;
        }
      }
      appendFileSync('decisions.jsonl', JSON.stringify({ layout: key, mover, game: g, at: i, ref, looks, ms } satisfies Row) + '\n');
    }
    console.log(`game ${g} done`);
  }
} else {
  const dirs = argv.filter((x, i) => !x.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  const rows: Row[] = [];
  const walk = (p: string) => {
    if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
    else if (p.endsWith('decisions.jsonl')) for (const line of readFileSync(p, 'utf8').split('\n')) if (line.trim()) rows.push(JSON.parse(line) as Row);
  };
  dirs.forEach(walk);
  const layouts = [...new Set(rows.map((r) => r.layout))].sort();
  const games = (rs: Row[]) => new Set(rs.map((r) => `${r.layout}/${r.mover}/${r.game}`)).size;
  const KEY = new Set<Label>(['inaccuracy', 'mistake', 'blunder']);

  md(`## #138: stricter label cuts on the REVIEW_CALIB games`);
  md('');
  md(`${rows.length} decisions in ${games(rows)} games (${layouts.join(', ')}; movers ${[...new Set(rows.map((r) => r.mover))].join(', ')}). Reference: the full review at 1,024 playouts per move. "Stable at n": the label at n playouts equals the reference's, over 3 seeds; "key" counts only decisions either calls an inaccuracy or worse.`);
  md('');
  md('### Labels per game (reference) and stability');
  md('');
  md('| cut set | rule | inaccuracies / game | mistakes / game | blunders / game | accuracy | stable at 128 | at 256 | at 512 | key stable at 128 | at 512 | turning point changed |');
  md('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const cuts of SETS)
    for (const v of VARIANTS) {
      const lab = (r: Row, l: Look) => label(l, cuts, r.layout, v);
      const refL = rows.map((r) => lab(r, r.ref));
      const per = (x: Label) => (refL.filter((l) => l === x).length / games(rows)).toFixed(1);
      const acc = (100 * refL.reduce((t, l) => t + SCORE[l], 0)) / refL.length;
      const stable = (n: number, keyOnly = false) => {
        let same = 0;
        let all = 0;
        rows.forEach((r, k) => {
          for (const l of r.looks[n]!) {
            const x = lab(r, l);
            if (keyOnly && !KEY.has(x) && !KEY.has(refL[k]!)) continue;
            all++;
            if (x === refL[k]) same++;
          }
        });
        return all ? `${((100 * same) / all).toFixed(1)}%` : '-';
      };
      const tpChanged = v.tp ? rows.filter((r) => label(r.ref, cuts, r.layout, { se: v.se, tp: true }) !== label(r.ref, cuts, r.layout, { se: v.se, tp: false })).length : 0;
      md(`| ${cuts.name} | ${v.name} | ${per('inaccuracy')} | ${per('mistake')} | ${per('blunder')} | ${acc.toFixed(1)}% | ${stable(128)} | ${stable(256)} | ${stable(512)} | ${stable(128, true)} | ${stable(512, true)} | ${v.tp ? `${tpChanged} (${((100 * tpChanged) / rows.length).toFixed(1)}%)` : ''} |`);
    }
  md('');
  md('### Review time per game (full review of every decision, no early stop: the app\'s race makes it faster)');
  md('');
  md('| layout | games | decisions / game | 128 | 256 | 512 | 1,024 |');
  md('|---|---:|---:|---:|---:|---:|---:|');
  for (const L of layouts) {
    const rs = rows.filter((r) => r.layout === L);
    const ng = games(rs);
    const t = (n: number) => `${(rs.reduce((s, r) => s + (r.ms[n] ?? 0), 0) / ng / 1000).toFixed(0)} s`;
    md(`| ${L} | ${ng} | ${(rs.length / ng).toFixed(0)} | ${t(128)} | ${t(256)} | ${t(512)} | ${t(1024)} |`);
  }
  md('');
  md('### Labels per game by layout (reference, plain rule)');
  md('');
  md('| layout | ' + SETS.map((c) => `${c.name}: inacc. / mist. / blund.`).join(' | ') + ' |');
  md('|---|' + SETS.map(() => '---').join('|') + '|');
  for (const L of layouts) {
    const rs = rows.filter((r) => r.layout === L);
    const ng = games(rs);
    md(`| ${L} | ` + SETS.map((c) => (['inaccuracy', 'mistake', 'blunder'] as Label[]).map((x) => (rs.filter((r) => label(r.ref, c, r.layout, VARIANTS[0]!) === x).length / ng).toFixed(1)).join(' / ')).join(' | ') + ' |');
  }
  md('');
  // Examples for the owner: decisions where the sets disagree, spread over the gaps.
  md('### Examples (2p where possible): the same decision under each set (plain, + se rule, + turning point)');
  md('');
  md('| decision | gap ± se (pts) | your chance → best\'s | ' + SETS.map((c) => c.name).join(' | ') + ' |');
  md('|---|---|---|' + SETS.map(() => '---').join('|') + '|');
  const differ = rows.filter((r) => new Set(SETS.map((c) => label(r.ref, c, r.layout, VARIANTS[0]!))).size > 1).sort((x, y) => x.ref.gap - y.ref.gap);
  const pick: Row[] = [];
  for (const q of [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 0.97]) {
    const r = differ[Math.floor(q * (differ.length - 1))];
    if (r && !pick.includes(r)) pick.push(r);
  }
  const tp = rows.find((r) => r.ref.best >= 50 && r.ref.mine < 50 && r.ref.gap > 0.5 && r.ref.gap < 3);
  if (tp && !pick.includes(tp)) pick.push(tp);
  for (const r of pick)
    md(`| ${r.layout} ${r.mover} game ${r.game}, state ${r.at} | ${r.ref.gap.toFixed(2)} ± ${r.ref.se.toFixed(2)} | ${r.ref.mine.toFixed(1)}% → ${r.ref.best.toFixed(1)}% | ` + SETS.map((c) => VARIANTS.map((v) => label(r.ref, c, r.layout, v)).join(' / ')).join(' | ') + ' |');
  md('');
}
