// #138 follow-up: how steady are the new labels through the app's own review, and what does the near-a-cut
// zone (EDGE) cost? On the REVIEW_CALIB games of the #138 study (review_cuts.ts's games), seat 0's decisions
// are reviewed by the app's path (review.ts reviewMoves: the stakes order, the race, the full review and
// its top-ups up to PLAYOUTS_MAX) under:
//   v3            review version 3's rules (RULES_V3: cuts C, no se rule, no turning point, EDGE 2): today
//   B, edge e     the new rules (RULES: cuts B, the se rule, the turning point) with EDGE e
// and each label is compared with the 1,024-playout reference from the study (its decisions.jsonl), labelled
// under the same rules. Reports, per variant: key-label agreement (decisions either side calls an inaccuracy
// or worse), all-label agreement, and the review time per game.
//   node tools/ai/dist/review_edge.mjs --task eval --layout 2p --mover hard --ref <study dir> [--games 5] [--seeds 2] [--edges 1,1.5,2,3]
//   node tools/ai/dist/review_edge.mjs --task report <dirs...>
// .github/workflows/review-study.yml runs it with the study's artifacts.
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGame, move, roll, seededDie, seeded, type BotLevel, type GameRecord, type GameState, type Seat } from '../../src/engine';
import { chooseBotMove } from '../../src/engine/ai/levels';
import { PLAYOUT_RULES } from '../../src/engine/ai/playout-rules';
import { labelOf, layoutKey, reviewMoves, RULES, RULES_V3, turned, type Label, type LabelRules, type Reviewer } from '../../src/engine/ai/review';
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
const KEY = new Set<Label>(['inaccuracy', 'mistake', 'blunder']);

interface Ref {
  gap: number;
  se: number;
  mine: number;
  best: number;
}
interface Row {
  layout: string;
  mover: string;
  game: number;
  variant: string;
  seed: number;
  ms: number;
  /** per decision: [at, label, playouts-free gap, se, chance played, chance best] */
  moves: [number, Label, number, number, number, number][];
}

const walk = (dirs: string[], name: string, each: (line: string) => void) => {
  const go = (p: string) => {
    if (statSync(p).isDirectory()) for (const f of readdirSync(p)) go(join(p, f));
    else if (p.endsWith(name)) for (const line of readFileSync(p, 'utf8').split('\n')) if (line.trim()) each(line);
  };
  dirs.forEach(go);
};

/** A variant's rules by name: "v3", or "B@<edge>". */
const rulesOf = (v: string): LabelRules => (v === 'v3' ? RULES_V3 : { ...RULES, edge: Number(v.split('@')[1]) });
/** The reference decision's label under `rules` (fractions for the turning point). */
const refLabel = (r: Ref, layout: string, rules: LabelRules) => turned(labelOf(r.gap, r.se, layout, rules), r.mine / 100, r.best / 100, rules);

if (task === 'eval') {
  const layout = a.layout ?? '2p';
  const mover = (a.mover ?? 'hard') as BotLevel;
  const games = Number(a.games ?? 5);
  const from = Number(a.from ?? 1);
  const seeds = Number(a.seeds ?? 2);
  const variants = ['v3', ...(a.edges ?? '1,1.5,2,3').split(',').map((e) => `B@${e}`)];
  const root = new URL('../../../', import.meta.url);
  const engine = await RolloutEngine.create(readFileSync(new URL('src/engine/ai/ludo_wasm.wasm', root)), new Uint8Array(readFileSync(new URL('src/engine/ai/extreme-net.bin', root))), PLAYOUT_RULES);
  const reviewer: Reviewer = async (s, n, seed, ask) => engine.reviewFast(s, n, seed, ask);
  /** review_cuts.ts's game (the study's). */
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
  writeFileSync('edge.jsonl', '');
  for (let g = from; g < from + games; g++) {
    const base = game(g);
    const states = replay(base).states as GameState[];
    const key = layoutKey(states[0]!);
    for (let k = 0; k < seeds; k++)
      for (const variant of variants) {
        // The decisions' seeds come from the record's seed: another seed, another set of playouts.
        const rec = { ...base, seed: g * 1000 + k };
        const t = performance.now();
        const out = await reviewMoves(rec, states, [0], reviewer, undefined, undefined, undefined, { order: 'stakes', rules: rulesOf(variant) });
        const row: Row = { layout: key, mover, game: g, variant, seed: k, ms: performance.now() - t, moves: out.map((m) => [m.at, m.label, m.gap, m.se, m.playedChance, m.bestChance]) };
        appendFileSync('edge.jsonl', JSON.stringify(row) + '\n');
      }
    console.log(`game ${g} done`);
  }
} else {
  const dirs = argv.filter((x, i) => !x.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  const refs = new Map<string, Ref>();
  walk(dirs, 'decisions.jsonl', (line) => {
    const r = JSON.parse(line) as { layout: string; mover: string; game: number; at: number; ref: Ref };
    refs.set(`${r.layout}/${r.mover}/${r.game}/${r.at}`, r.ref);
  });
  const rows: Row[] = [];
  walk(dirs, 'edge.jsonl', (line) => rows.push(JSON.parse(line) as Row));
  const variants = [...new Set(rows.map((r) => r.variant))];
  const layouts = [...new Set(rows.map((r) => r.layout))].sort();
  const gamesOf = (rs: Row[]) => new Set(rs.map((r) => `${r.layout}/${r.mover}/${r.game}/${r.seed}`)).size;
  const v3ms = rows.filter((r) => r.variant === 'v3').reduce((s, r) => s + r.ms, 0) / Math.max(1, gamesOf(rows.filter((r) => r.variant === 'v3')));
  const stats = (rs: Row[], variant: string) => {
    const rules = rulesOf(variant);
    let all = 0, same = 0, keyN = 0, keySame = 0;
    for (const r of rs)
      for (const [at, label] of r.moves) {
        const ref = refs.get(`${r.layout}/${r.mover}/${r.game}/${at}`);
        if (!ref) continue;
        const want = refLabel(ref, r.layout, rules);
        all++;
        if (want === label) same++;
        if (KEY.has(want) || KEY.has(label)) {
          keyN++;
          if (want === label) keySame++;
        }
      }
    const ms = rs.reduce((s, r) => s + r.ms, 0) / Math.max(1, gamesOf(rs));
    return { all, same, keyN, keySame, ms };
  };
  const pct = (x: number, n: number) => (n ? `${((100 * x) / n).toFixed(1)}%` : '-');
  md('## #138 follow-up: the new labels through the app\'s own review, by EDGE');
  md('');
  md(`${rows.length} game reviews (${gamesOf(rows.filter((r) => r.variant === variants[0]))} games × seeds per variant). Each label is the app's (reviewMoves: stakes order, race, full review, top-ups up to 1,024 playouts) compared with the study's 1,024-playout reference under the same rules. "v3" is today's review (cuts C, no se rule, no turning point, EDGE 2).`);
  md('');
  md('| variant | key labels agreeing | all labels agreeing | review time per game | vs today |');
  md('|---|---:|---:|---:|---:|');
  for (const v of variants) {
    const s = stats(rows.filter((r) => r.variant === v), v);
    md(`| ${v === 'v3' ? 'v3 (today)' : `B, EDGE ${v.split('@')[1]}`} | ${pct(s.keySame, s.keyN)} (${s.keySame}/${s.keyN}) | ${pct(s.same, s.all)} | ${(s.ms / 1000).toFixed(1)} s | ${(s.ms / v3ms).toFixed(2)}× |`);
  }
  md('');
  md('By layout (key labels agreeing / time per game):');
  md('');
  md('| layout | ' + variants.map((v) => (v === 'v3' ? 'v3 (today)' : `B, EDGE ${v.split('@')[1]}`)).join(' | ') + ' |');
  md('|---|' + variants.map(() => '---').join('|') + '|');
  for (const L of layouts)
    md(`| ${L} | ` + variants.map((v) => {
      const s = stats(rows.filter((r) => r.variant === v && r.layout === L), v);
      return `${pct(s.keySame, s.keyN)} / ${(s.ms / 1000).toFixed(1)} s`;
    }).join(' | ') + ' |');
  md('');
}
