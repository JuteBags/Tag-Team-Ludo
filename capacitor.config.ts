import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.jutebags.ludo',
  appName: 'Ludo',
  webDir: 'dist',
  // Matches the game background so there is no white flash while the WebView loads.
  backgroundColor: '#071a4f',
  plugins: {
    // Injects --safe-area-inset-* CSS variables; the stage fits inside them (src/ui/app.ts).
    SystemBars: { insetsHandling: 'css' },
  },
};

export default config;
