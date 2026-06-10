// Copies the freshly-built contract binding + stand-in proof into the dApp.
// Run automatically before `dev`/`build`, or manually via `npm run sync`.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';

mkdirSync('src/contracts', { recursive: true });
mkdirSync('public', { recursive: true });

const need = [
  ['../azns/target/AZNS.ts', 'src/contracts/AZNS.ts'],
  ['../azns/target/azns-AZNS.json', 'src/contracts/azns-AZNS.json'],
];
for (const [from, to] of need) {
  if (!existsSync(from)) {
    console.error(`missing ${from} - build the contract first (aztec compile + npm run codegen)`);
    process.exit(1);
  }
  copyFileSync(from, to);
}

if (existsSync('../zkp_data.json')) {
  copyFileSync('../zkp_data.json', 'public/zkp_data.json');
} else {
  console.warn('warning: ../zkp_data.json not found - run `npm run genproof` at repo root');
}

// Serve the bb.js WASM at /assets (matches BB_WASM_PATH in vite.config.ts).
// Only the multithreaded gz ships in the package; we're cross-origin isolated
// so that's the one bb loads. We also write it under the single-threaded name
// because bb derives the threads path from BB_WASM_PATH's base name.
mkdirSync('public/assets', { recursive: true });
const bbThreads = 'node_modules/@aztec/bb.js/dest/node/barretenberg_wasm/barretenberg-threads.wasm.gz';
if (existsSync(bbThreads)) {
  copyFileSync(bbThreads, 'public/assets/barretenberg-threads.wasm.gz');
  copyFileSync(bbThreads, 'public/assets/barretenberg.wasm.gz');
} else {
  console.warn(`warning: ${bbThreads} not found - run npm install in dapp/ first`);
}
console.log('synced contract binding + proof + bb wasm into dapp/');
