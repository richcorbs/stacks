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
          // must stay in the lazy Pi/card-description chunks instead of leaking
          // into the entry or vendor chunks. Both PiGuiView and CardOverview load
          // the renderer dynamically, so keep those imports static-free here.
          // DOMPurify remains in vendor because CardOverview sanitizes remote
          // description HTML independently of the lazy renderer.
          groups: [
            { name: 'react', test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/, priority: 5 },
            // Recursively capturing helpers here would make the eager entry import the
            // lazy markdown chunk, so let marked's generated helpers stay in common chunks.
            { name: 'markdown', test: /node_modules[\\/]marked[\\/]/, priority: 4, includeDependenciesRecursively: false },
            { name: 'xterm', test: /node_modules[\\/]@xterm[\\/]/, priority: 3 },
            { name: 'vendor', test: /node_modules[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
});
