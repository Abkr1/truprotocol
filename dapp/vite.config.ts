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
      {
        // COOP/COEP on EVERY dev response, including vite-internal paths like
        // /node_modules/.vite/deps/worker.js?worker_file: under cross-origin
        // isolation a module worker's own response must carry COEP too, and
        // `server.headers` does not reach those — without this the kv-store
        // SQLite-OPFS worker is blocked (ERR_BLOCKED_BY_RESPONSE) and the PXE
        // dies with "SQLite worker crashed".
        name: 'cross-origin-isolation-everywhere',
        configureServer(server: any) {
          server.middlewares.use((_req: any, res: any, next: any) => {
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
            next();
          });
        },
        configurePreviewServer(server: any) {
          server.middlewares.use((_req: any, res: any, next: any) => {
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
            next();
          });
        },
      },
    ],
    define: {
      // Expose selected env vars to the browser bundle.
      'process.env.AZTEC_NODE_URL': JSON.stringify(env.AZTEC_NODE_URL ?? ''),
      'process.env.AZNS_ADDRESS': JSON.stringify(env.AZNS_ADDRESS ?? ''),
      'process.env.PAY_TOKEN_ADDRESS': JSON.stringify(env.PAY_TOKEN_ADDRESS ?? ''),
      'process.env.FAUCET_ADDRESS': JSON.stringify(env.FAUCET_ADDRESS ?? ''),
      'process.env.BEACON_ADDRESS': JSON.stringify(env.BEACON_ADDRESS ?? ''),
      // bb.js loads its WASM from this path; the -threads variant is inferred.
      // We copy the file into public/assets via sync.mjs.
      'process.env.BB_WASM_PATH': JSON.stringify('/assets/barretenberg.wasm.gz'),
    },
    optimizeDeps: {
      // Don't let esbuild pre-bundle the WASM/worker-bearing packages:
      // prebundling breaks `new URL(..., import.meta.url)` asset resolution
      // (wasm requests fall through to index.html), and the dep optimizer
      // fails to emit kv-store's SQLite worker at all when that worker
      // imports the excluded sqlite3mc-wasm (dangling .vite/deps/worker.js
      // 404 -> "SQLite worker crashed"). Excluding BOTH serves the real files
      // from node_modules; the first dev load streams a large raw module
      // graph (slow once, then cached).
      exclude: ['@aztec/bb.js', '@aztec/noir-acvm_js', '@aztec/noir-noirc_abi', '@aztec/kv-store', '@aztec/sqlite3mc-wasm'],
      esbuildOptions: { target: 'esnext' },
    },
    build: { target: 'esnext' },
  };
});
