import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// Set by `tauri android|ios dev` so physical devices can reach the dev server.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 5174 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  // The app's version (shown in the lobby and Settings › Help), bumped with each release.
  define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version) },
  build: {
    // WebView2 (Chromium) on Windows/Android, WebKit on macOS/iOS/Linux.
    target: ['es2022', 'chrome110', 'safari16'],
    minify: process.env.TAURI_ENV_DEBUG ? false : undefined,
    // Never inline AudioWorklet modules as data: URLs; the app's CSP only allows scripts from 'self'.
    assetsInlineLimit: (file) => (file.endsWith('.worklet.js') ? false : undefined),
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
