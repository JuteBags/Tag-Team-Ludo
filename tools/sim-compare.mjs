// Compares two `npm run sim` logs (main and a pull request) and prints a Markdown report for a PR comment.
// Usage: node tools/sim-compare.mjs base.log head.log > report.md
// Both runs use the same seeds, so a change that doesn't touch the game shows no differences at all.
import { readFileSync } from 'node:fs';

const read = (path) => {
  const line = readFileSync(path, 'utf8').split('\n').find((l) => l.startsWith('SIM_JSON '));
  if (!line) throw new Error(`no SIM_JSON line in ${path}`);
  return JSON.parse(line.slice('SIM_JSON '.length));
};

const [basePath, headPath] = process.argv.slice(2);
const base = read(basePath);
const head = read(headPath);
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
  const rows = head.metrics.map((m) => `| ${m.label.replaceAll('|', '\|')} | ${setups.map((s) => cell(m, s)).join(' | ')} |`);
  return [`| Metric | ${setups.map((s) => s.replace(' weighted', '').replace(' fair', '')).join(' | ')} |`, `|---|${setups.map(() => '---').join('|')}|`, ...rows].join('\n');
}

const weighted = ['2p weighted', '3p weighted', '4p weighted'];
const fair = ['2p fair', '3p fair', '4p fair'];
const changed = head.metrics.some((m) => [...weighted, ...fair].some((s) => Math.abs((head.setups[s]?.[m.key] ?? 0) - (base.setups[s]?.[m.key] ?? 0)) > 1e-9));

console.log(`<!-- sim-compare -->
## 🎲 Simulation: \`main\` → this PR

${head.games} all-bot games per setup, the same seeds on both sides. ${changed ? 'Changes of 5% or more are in **bold**.' : '**No change**: this PR does not change how games play out.'} "Player" rows are one seat (Blue, the seat a human plays).

### With the game's dice
${table(weighted)}

<details><summary>With fair dice (for comparison)</summary>

${table(fair)}

</details>`);
