import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Relative base so the same build works on the web and inside Capacitor.
export default defineConfig({
  base: './',
  server: { port: 5173 },
  // The app version shown on the home screen comes from package.json.
  define: { __APP_VERSION__: JSON.stringify(version) },
});
