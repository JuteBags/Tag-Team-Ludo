import { defineConfig } from 'vitest/config';

// `npm run sim`: the long all-bot simulations in tests/*.sim.ts, kept out of `npm test`.
export default defineConfig({
  test: { include: ['tests/**/*.sim.ts'], silent: false },
});
