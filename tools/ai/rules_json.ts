// Writes the playout rules and Hard's rules as JSON for the native tools (ludo-brilliant #100, the h2h harness #148), from the
// same sources the app uses: node tools/ai/dist/rules_json.mjs <dir>  ->  <dir>/playout-rules.json, hard-rules.json
import { writeFileSync } from 'node:fs';
import { HARD_RULES } from '../../src/engine/ai/hard-rules';
import { PLAYOUT_RULES } from '../../src/engine/ai/playout-rules';

const dir = process.argv[2] ?? '.';
writeFileSync(`${dir}/playout-rules.json`, JSON.stringify(PLAYOUT_RULES));
writeFileSync(`${dir}/hard-rules.json`, JSON.stringify(HARD_RULES));
console.log(`wrote ${dir}/playout-rules.json and hard-rules.json`);
