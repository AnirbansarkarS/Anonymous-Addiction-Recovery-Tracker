import { defineConfig } from 'vite';
import { viteCommonjs } from '@originjs/vite-plugin-commonjs';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig(({ mode }) => ({
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development'),
    'process.env': {},
    global: 'globalThis',
  },
  plugins: [
    nodePolyfills({
      include: ['buffer', 'process', 'path', 'url', 'util', 'stream', 'events', 'http', 'https'],
      globals: {
        Buffer: true,
        process: true,
      },
    }),
    wasm(),
    viteCommonjs(),
    topLevelAwait(),
  ],
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
    exclude: [
      "@midnight-ntwrk/onchain-runtime",
      "@midnight-ntwrk/compact-runtime"
    ],
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
}));
