// Copies the freshly-built contract binding into the dApp.
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

// Optional: the open-mint Faucet binding (only present if faucet/ was built).
for (const [from, to] of [
  ['../faucet/target/Faucet.ts', 'src/contracts/Faucet.ts'],
  ['../faucet/target/faucet-Faucet.json', 'src/contracts/faucet-Faucet.json'],
]) {
  if (existsSync(from)) copyFileSync(from, to);
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
