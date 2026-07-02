// =============================================================================
//  gas_probe.ts - poll the network's min fee until it dips below a threshold.
// =============================================================================
//  The AZNS deploy needs ~1.9M L2 gas; with ~2.83 juice left it only fits when
//  feePerL2Gas <= ~1.45e12. Exits 0 the moment the fee is low enough (then run
//  the deploy immediately), 2 if it stayed expensive for the whole window.
//  Env: THRESHOLD (wei/L2gas, default 1450000000000), CHECKS, INTERVAL_MS.
// =============================================================================
import { tolerantNode } from './fees.js';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'https://v5.testnet.rpc.aztec-labs.com';
const THRESHOLD = BigInt(process.env.THRESHOLD ?? '1450000000000');
const CHECKS = Number(process.env.CHECKS ?? 12);
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 45_000);

async function main() {
  const node = tolerantNode(NODE_URL);
  for (let i = 1; i <= CHECKS; i++) {
    try {
      const f: any = await node.getCurrentMinFees();
      const perL2 = BigInt(f.feePerL2Gas.toString());
      console.log(`[${new Date().toISOString()}] ${i}/${CHECKS} feePerL2Gas=${perL2} (target <= ${THRESHOLD})`);
      if (perL2 <= THRESHOLD) { console.log('CHEAP_ENOUGH'); process.exit(0); }
    } catch (e: any) {
      console.log(`probe error: ${String(e?.message ?? e).slice(0, 80)}`);
    }
    if (i < CHECKS) await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  console.log('STILL_EXPENSIVE');
  process.exit(2);
}
main();
