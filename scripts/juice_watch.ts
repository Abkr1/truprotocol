// =============================================================================
//  juice_watch.ts - poll the deployer's fee-juice balance until the faucet
//  drip lands (the Nethermind faucet bridges L1->L2 in ~3-4 min).
// =============================================================================
//  Exits 0 the moment the balance turns positive; exits 1 after ~30 min.
//  Run (repo root, WSL):  bash run_juice_watch.sh
// =============================================================================
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { getFeeJuiceBalance } from '@aztec/aztec.js/utils';
import { tolerantNode } from './fees.js';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'https://v5.testnet.rpc.aztec-labs.com';
// The stable deployer (scripts/.deployer.json); printed by `npm run fund:status`.
const ADDR = process.env.WATCH_ADDR ?? '0x07fa750e0175ea9e068b1cd593f13037081068aea67b23e51bd7a0a7026cbc74';
const INTERVAL_MS = 60_000;
const MAX_CHECKS = 30;

async function main() {
  const node = tolerantNode(NODE_URL);
  const addr = AztecAddress.fromStringUnsafe(ADDR);
  console.log(`watching fee juice of ${ADDR} on ${NODE_URL}`);
  for (let i = 1; i <= MAX_CHECKS; i++) {
    try {
      const bal = await getFeeJuiceBalance(addr, node);
      console.log(`[${new Date().toISOString()}] check ${i}/${MAX_CHECKS}: ${bal}`);
      if (bal > 0n) { console.log(`FUNDED: ${bal}`); process.exit(0); }
    } catch (e: any) {
      console.log(`check ${i} error: ${String(e?.message ?? e).slice(0, 100)}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  console.log('TIMEOUT: still unfunded after 30 min');
  process.exit(1);
}
main();
