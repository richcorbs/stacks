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
          // Keep these boundaries coarse and deterministic. In particular, every
          // package in the unified/remark/rehype parser ecosystem must stay with
          // the lazy Pi view instead of leaking into the eagerly loaded fallback.
          groups: [
            { name: 'react', test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/, priority: 5 },
            { name: 'markdown', test: /node_modules[\\/](?:react-markdown|remark(?:-[^\\/]+)?|rehype(?:-[^\\/]+)?|unified|micromark(?:-[^\\/]+)?|mdast-util(?:-[^\\/]+)?|hast-util(?:-[^\\/]+)?|unist-util(?:-[^\\/]+)?|vfile(?:-[^\\/]+)?|parse5|entities|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities(?:-[^\\/]+)?|html-void-elements|web-namespaces|trim-lines|trough|zwitch|bail|ccount|devlop|escape-string-regexp|is-plain-obj|markdown-table)[\\/]/, priority: 4 },
            { name: 'xterm', test: /node_modules[\\/]@xterm[\\/]/, priority: 3 },
            { name: 'vendor', test: /node_modules[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
});
