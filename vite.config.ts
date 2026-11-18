import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari15',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Keep these boundaries coarse and deterministic. The Markdown parser
          // must stay in the lazy Pi chunk instead of leaking into the entry or
          // vendor chunks. DOMPurify remains in vendor because CardOverview uses
          // it independently of the lazy Pi view.
          groups: [
            { name: 'react', test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/, priority: 5 },
            { name: 'markdown', test: /node_modules[\\/]marked[\\/]/, priority: 4 },
            { name: 'xterm', test: /node_modules[\\/]@xterm[\\/]/, priority: 3 },
            { name: 'vendor', test: /node_modules[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
});
