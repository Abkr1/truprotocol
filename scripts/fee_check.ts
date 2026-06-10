// Quick read-only check: does the canonical sponsored FPC have fee juice?
import { Fr } from '@aztec/aztec.js/fields';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'https://rpc.testnet.aztec-labs.com';

async function main() {
  const node = createAztecNodeClient(NODE_URL);
  const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(0n) });
  console.log('sponsored FPC:', fpc.address.toString());
  const { getFeeJuiceBalance } = await import('@aztec/aztec.js/utils');
  const bal = await getFeeJuiceBalance(fpc.address, node as any);
  console.log('FPC fee juice balance:', bal.toString());
  const minFees = await (node as any).getCurrentMinFees();
  console.log('current min fees: daGas =', minFees.feePerDaGas.toString(), ' l2Gas =', minFees.feePerL2Gas.toString());
}
main().catch((e) => { console.error(e.message); process.exit(1); });
