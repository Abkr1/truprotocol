import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    // Default cache (node_modules/.vite). On WSL, node_modules is symlinked to
    // the native Linux FS (see _wsl_serve.sh), so the optimizer's heavy writes
    // avoid the /mnt/c 9p I/O errors while excluded deps still resolve.
    server: {
      port: 5173,
      // Required so Barretenberg (bb) WASM can run in multithreaded mode
      // (SharedArrayBuffer needs cross-origin isolation).
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
    preview: {
      port: 4173,
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
    plugins: [
      react(),
      nodePolyfills({ include: ['buffer', 'path', 'process', 'util', 'stream', 'events'] }),
    ],
    define: {
      // Expose selected env vars to the browser bundle.
      'process.env.AZTEC_NODE_URL': JSON.stringify(env.AZTEC_NODE_URL ?? ''),
      'process.env.AZNS_ADDRESS': JSON.stringify(env.AZNS_ADDRESS ?? ''),
      'process.env.PAY_TOKEN_ADDRESS': JSON.stringify(env.PAY_TOKEN_ADDRESS ?? ''),
      // bb.js loads its WASM from this path; the -threads variant is inferred.
      // We copy the file into public/assets via sync.mjs.
      'process.env.BB_WASM_PATH': JSON.stringify('/assets/barretenberg.wasm.gz'),
    },
    optimizeDeps: {
      // Don't let esbuild pre-bundle the WASM-bearing packages: prebundling
      // breaks their `new URL(..., import.meta.url)` asset resolution, which
      // makes .wasm requests fall through to index.html. Excluded => Vite
      // serves their colocated *_bg.wasm from node_modules directly.
      exclude: ['@aztec/bb.js', '@aztec/noir-acvm_js', '@aztec/noir-noirc_abi'],
      esbuildOptions: { target: 'esnext' },
    },
    build: { target: 'esnext' },
  };
});
