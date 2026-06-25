// =============================================================================
//  claim_juice.ts - consume a faucet fee-juice claim for the (already
//  deployed) deployer account.
// =============================================================================
//  The faucet bridges fee juice on L1 and hands back { amount, secret, leaf
//  index }. A claim is consumed by ANY transaction that pays its fee with
//  FeeJuicePaymentMethodWithClaim (the claim itself funds the tx in its setup
//  phase), crediting the remainder to the account. We send one harmless tx:
//  repointing a name we own at its current owner.
//
//  Usage (env): CLAIM_AMOUNT=... CLAIM_SECRET=0x... CLAIM_INDEX=... \
//               [CLAIM_NAME=modeprice1] npm run claim:juice
//  (CLAIM_NAME, not NAME: WSL exports NAME as the machine hostname.)
// =============================================================================
import { Fr } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { FeeJuicePaymentMethodWithClaim } from '@aztec/aztec.js/fee';
import { getFeeJuiceBalance } from '@aztec/aztec.js/utils';
import { AZNSContract } from '../azns/target/AZNS.js';
import { setupDeployer } from './fees.js';
import { nameHash } from './lib.js';
import fs from 'node:fs';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'https://v5.testnet.rpc.aztec-labs.com';
const NAME = process.env.CLAIM_NAME ?? 'modeprice1';

function aznsAddr(): string {
  if (process.env.AZNS_ADDRESS) return process.env.AZNS_ADDRESS;
  const m = fs.readFileSync('dapp/.env', 'utf-8').match(/AZNS_ADDRESS=(0x[0-9a-fA-F]+)/);
  if (!m) throw new Error('AZNS_ADDRESS not found');
  return m[1];
}

async function main() {
  const a = process.env.CLAIM_AMOUNT, s = process.env.CLAIM_SECRET, i = process.env.CLAIM_INDEX;
  if (!a || !s || !i) throw new Error('set CLAIM_AMOUNT, CLAIM_SECRET and CLAIM_INDEX (from the faucet claim command)');
  const claim = { claimAmount: BigInt(a), claimSecret: Fr.fromString(s), messageLeafIndex: BigInt(i) };

  const { wallet, account, node } = await setupDeployer(NODE_URL);
  const before = await getFeeJuiceBalance(account, node as any);
  console.log(`balance before: ${before}`);

  const inst = await node.getContract(AztecAddress.fromString(aznsAddr()));
  if (!inst) throw new Error('AZNS contract not found on the node');
  await wallet.registerContract(inst, AZNSContract.artifact);
  const azns = await AZNSContract.at(AztecAddress.fromString(aznsAddr()), wallet);

  console.log(`consuming claim (${claim.claimAmount}) via a no-op repoint of ${NAME}.tru ...`);
  const fee = { paymentMethod: new FeeJuicePaymentMethodWithClaim(account, claim) };
  await azns.methods.set_public_target(await nameHash(NAME), account).send({ from: account, fee });

  const after = await getFeeJuiceBalance(account, node as any);
  console.log(`balance after : ${after}`);
  console.log(`credited      : ${after - before} (claim minus this tx's fee)`);
  if (after <= before) throw new Error('balance did not increase - claim not consumed?');
  console.log('\nCLAIM OK - the deployer is refuelled.');
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
