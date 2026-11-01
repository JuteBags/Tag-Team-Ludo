import { defineConfig } from 'vitest/config';

// `npm run sim`: the long all-bot simulations in tests/*.sim.ts, kept out of `npm test`.
export default defineConfig({
  test: { include: ['tests/**/*.sim.ts'], silent: false },
});

# Automated fix for issue #68: vs Computer setup: two houses each and choosing your house are hard to find (Quick Start is always Blue)
