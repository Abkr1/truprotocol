// =============================================================================
//  fund_status.ts - show the STABLE deployer account + its fee-juice balance.
// =============================================================================
//  Creates (once) a deterministic deployer account whose secret is saved in
//  scripts/.deployer.json (gitignored), prints its address so you can faucet
//  fee juice to it, and reports whether it's funded yet. Run: npm run fund:status
//
//  To fund it: open the Aztec faucet, paste the address below, request Fee Juice:
//    https://aztec-faucet.dev-nethermind.xyz/   (or nethermind.io faucet)
// =============================================================================
import { Fr } from '@aztec/aztec.js/fields';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { getFeeJuiceBalance } from '@aztec/aztec.js/utils';
import { loadDeployerKeys } from './fees.js';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'https://rpc.testnet.aztec-labs.com';

async function main() {
  const keys = loadDeployerKeys();
  const wallet = await EmbeddedWallet.create(NODE_URL, { ephemeral: true });
  await wallet.createSchnorrAccount(Fr.fromString(keys.secret), Fr.fromString(keys.salt));
  const account = (await wallet.getAccounts())[0].item;
  const node = createAztecNodeClient(NODE_URL);

  const bal = await getFeeJuiceBalance(account, node as any);
  const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(0n) });
  const fpcBal = await getFeeJuiceBalance(fpc.address, node as any);
  const minFees: any = await (node as any).getCurrentMinFees();
  const minL2 = BigInt(minFees.feePerL2Gas.toString());

  console.log('\n=== AZNS testnet deployer ===');
  console.log('node            :', NODE_URL);
  console.log('DEPLOYER ADDRESS:', account.toString());
  console.log('deployer fee juice:', bal.toString(), bal > 0n ? '  ✅ FUNDED — you can run deploy:testnet' : '  ⛔ empty');
  console.log('\n--- shared sponsored FPC (fallback) ---');
  console.log('FPC fee juice  :', fpcBal.toString());
  console.log('min fee / L2gas:', minL2.toString());
  console.log('FPC sponsorable: ~', (minL2 > 0n ? (fpcBal / minL2).toString() : 'n/a'), 'gas (a deploy needs tens of millions)');

  if (bal === 0n) {
    console.log('\nNext: fund the DEPLOYER ADDRESS above with Fee Juice at the Aztec faucet,');
    console.log('then re-run `npm run fund:status` to confirm, then `npm run deploy:testnet`.');
  }
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
