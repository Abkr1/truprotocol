// =============================================================================
//  fees.ts - shared deployer account + automatic fee selection for testnet.
// =============================================================================
//  Uses the STABLE deployer (scripts/.deployer.json) so the faucet target is
//  constant. Picks the fee payer automatically:
//    1. native fee juice  - if the deployer's fee-juice balance is funded
//    2. claim             - if FEE_CLAIM env holds the faucet's claim data
//    3. sponsored FPC      - fallback (shared, often drained on testnet)
// =============================================================================
import { Fr } from '@aztec/aztec.js/fields';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { FeeJuicePaymentMethodWithClaim } from '@aztec/aztec.js/fee';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { getFeeJuiceBalance } from '@aztec/aztec.js/utils';
import fs from 'node:fs';
import path from 'node:path';

const KEYFILE = path.join('scripts', '.deployer.json');
/** Load (or create once) the deterministic deployer key. Gitignored. */
export function loadDeployerKeys(): { secret: string; salt: string } {
  if (fs.existsSync(KEYFILE)) return JSON.parse(fs.readFileSync(KEYFILE, 'utf-8'));
  const keys = { secret: Fr.random().toString(), salt: Fr.random().toString() };
  fs.writeFileSync(KEYFILE, JSON.stringify(keys, null, 2));
  console.log(`created a new deployer key -> ${KEYFILE} (gitignored)`);
  return keys;
}

export async function setupDeployer(NODE_URL: string) {
  const proverEnabled = !/localhost|127\.0\.0\.1/.test(NODE_URL);
  const wallet = await EmbeddedWallet.create(NODE_URL, { pxe: { proverEnabled } });
  const keys = loadDeployerKeys();
  const manager = await wallet.createSchnorrAccount(Fr.fromString(keys.secret), Fr.fromString(keys.salt));
  const account = (await wallet.getAccounts())[0].item;
  const node = createAztecNodeClient(NODE_URL);

  // Register the sponsored FPC (used as fallback).
  const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(0n) });
  await wallet.registerContract(fpc, SponsoredFPCContract.artifact);

  // Choose how we pay.
  const bal = await getFeeJuiceBalance(account, node as any);
  let fee: any;
  let payer: string;
  if (bal > 0n) {
    fee = {}; // no paymentMethod => native fee juice from the sender
    payer = `native fee juice (deployer balance ${bal})`;
  } else if (process.env.FEE_CLAIM) {
    const claim = JSON.parse(process.env.FEE_CLAIM); // { claimAmount, claimSecret, messageLeafIndex }
    fee = { paymentMethod: new FeeJuicePaymentMethodWithClaim(account, claim) };
    payer = 'fee-juice claim (from faucet bridge)';
  } else {
    fee = { paymentMethod: new SponsoredFeePaymentMethod(fpc.address) };
    payer = 'shared sponsored FPC (fallback)';
  }
  console.log(`deployer: ${account.toString()}\nfee payer: ${payer}`);
  return { wallet, account, manager, node, fee };
}
