// Writes the app's level rules as the JSON files sim-rs reads (tools/ai/dist/levels/), so the level check
// (levels_check.py) measures exactly the weights the app ships.
import { mkdirSync, writeFileSync } from 'node:fs';
import { HARD_RULES } from '../../src/engine/ai/hard-rules';
import { PLAYOUT_RULES } from '../../src/engine/ai/playout-rules';

// Run as the bundle tools/ai/dist/levels-json.mjs (build.sh), so this is tools/ai/dist/levels/.
const dir = new URL('./levels/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL('hard.json', dir), JSON.stringify(HARD_RULES));
writeFileSync(new URL('playout.json', dir), JSON.stringify(PLAYOUT_RULES));
console.log('wrote', dir.pathname);
