// Compares two simulation logs (one tests/sim/*.sim.ts file, run on main and on a pull request) and prints
// one Markdown section of the PR comment. CI runs every simulation file in parallel and joins the sections.
// Usage: node tools/sim-compare.mjs base.log head.log >> report.md
// Both runs use the same seeds, so a change that doesn't touch the game shows no differences at all.
import { readFileSync } from 'node:fs';

const read = (path) => {
  const line = readFileSync(path, 'utf8').split('\n').find((l) => l.startsWith('SIM_JSON '));
  if (!line) throw new Error(`no SIM_JSON line in ${path}`);
  return JSON.parse(line.slice('SIM_JSON '.length));
};

const [basePath, headPath] = process.argv.slice(2);
const head = read(headPath);
// If main couldn't be measured (e.g. the PR's simulation needs engine changes main doesn't have),
// still report the PR's numbers.
let base = { setups: {} };
let baseNote = '';
try {
  base = read(basePath);
} catch {
  base = { setups: {} };
}
// A run where every setup failed still prints SIM_JSON, with no setups: that's "couldn't measure" too.
if (Object.keys(base.setups ?? {}).length === 0) {
  base = { setups: {} };
  baseNote = "\n\n⚠️ `main` could not be measured with this PR's simulation (it probably needs engine changes from this PR), so only this PR's numbers are shown.";
}
const fmt = (m, v) => (v === undefined || Number.isNaN(v) ? '–' : m.pct ? `${(100 * v).toFixed(1)}%` : v.toFixed(1));

function cell(m, setup) {
  const a = base.setups[setup]?.[m.key];
  const b = head.setups[setup]?.[m.key];
  if (a === undefined) return `${fmt(m, b)} (new)`;
  if (Math.abs(b - a) < 1e-9) return fmt(m, b);
  const rel = a ? ((b - a) / Math.abs(a)) * 100 : 0;
  const arrow = b > a ? '▲' : '▼';
  const text = `${fmt(m, a)} → ${fmt(m, b)} ${arrow}${Math.abs(rel).toFixed(1)}%`;
  return Math.abs(rel) >= 5 ? `**${text}**` : text;
}

function table(setups) {
  // A '|' inside a label would split the Markdown table cell.
  const rows = head.metrics.map((m) => `| ${m.label.replaceAll('|', '\\|')} | ${setups.map((s) => cell(m, s)).join(' | ')} |`);
  return [`| Metric | ${setups.map((s) => s.replace(/ (weighted|fair)$/, '')).join(' | ')} |`, `|---|${setups.map(() => '---').join('|')}|`, ...rows].join('\n');
}

const setups = Object.keys(head.setups);
const weighted = setups.filter((s) => s.endsWith(' weighted'));
const fair = setups.filter((s) => s.endsWith(' fair'));
const changed = head.metrics.some((m) => setups.some((s) => Math.abs((head.setups[s]?.[m.key] ?? 0) - (base.setups[s]?.[m.key] ?? 0)) > 1e-9));

console.log(`### ${head.title ?? 'Simulation'}

${head.games} all-bot games per setup and dice. ${changed ? 'Changes of 5% or more are in **bold**.' : '**No change**: this PR does not change how these games play out.'}${baseNote}

${table(weighted)}

<details><summary>With fair dice (for comparison)</summary>

${table(fair)}

</details>
`);
