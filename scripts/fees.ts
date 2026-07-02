// =============================================================================
//  fees.ts - shared deployer account + automatic fee selection for testnet.
// =============================================================================
//  Uses the STABLE deployer (scripts/.deployer.json) so the faucet target is
//  constant. Picks the fee payer automatically:
//    1. native fee juice  - if the deployer's fee-juice balance is funded
//    2. claim             - if FEE_CLAIM env holds the faucet's claim data
//    3. sponsored FPC      - fallback (shared, often drained on testnet)
// =============================================================================
import { NO_FROM } from '@aztec/aztec.js/account';
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

/**
 * Read the faucet's L1->L2 bridge claim from env (set after fauceting Fee Juice):
 *   CLAIM_AMOUNT  e.g. 100000000000000000000
 *   CLAIM_SECRET  e.g. 0x2518...   (the --claim-secret value)
 *   CLAIM_INDEX   e.g. 109222912   (the --message-leaf-index value)
 * Plain vars (no JSON) so there is no quoting to fight across PowerShell/bash.
 */
function parseClaim() {
  const a = process.env.CLAIM_AMOUNT, s = process.env.CLAIM_SECRET, i = process.env.CLAIM_INDEX;
  if (!a || !s || !i) return null;
  return {
    claimAmount: BigInt(a),          // wrapped in new Fr() by the SDK -> bigint
    claimSecret: Fr.fromString(s),   // used as a Field directly -> Fr
    messageLeafIndex: BigInt(i),     // wrapped in new Fr() -> bigint
  };
}

/**
 * Connect the stable deployer, make sure its account is on-chain, and return a
 * single `fee` object usable for every subsequent contract call.
 *
 * Bootstrapping the account is the moment we pay with whatever we have:
 *   - native fee juice  -> if the deployer is already funded
 *   - one-time claim     -> consumes the faucet's L1->L2 bridge (FEE_CLAIM env),
 *                           which credits the rest of the juice to the account,
 *                           so every later tx falls back to native
 *   - sponsored FPC       -> shared fallback (often drained on testnet)
 */
// The public testnet node does NOT implement the debug-only RPC method
// `aztec_registerContractFunctionSignatures` (-32601). The server PXE (node
// entrypoint) calls it during PXE.create / registerContract, which aborts setup.
// Wrap the node client so that one method is a harmless no-op (registering
// function signatures is only for debugging); everything else passes through.
export function tolerantNode(url: string): any {
  const node: any = createAztecNodeClient(url);
  return new Proxy(node, {
    get(target, prop, recv) {
      if (prop === 'registerContractFunctionSignatures') return async () => {};
      return Reflect.get(target, prop, recv);
    },
  });
}

export async function setupDeployer(NODE_URL: string) {
  const proverEnabled = !/localhost|127\.0\.0\.1/.test(NODE_URL);
  const node = tolerantNode(NODE_URL);
  const wallet = await EmbeddedWallet.create(node, { pxe: { proverEnabled } });
  const keys = loadDeployerKeys();
  const manager = await wallet.createSchnorrAccount(Fr.fromString(keys.secret), Fr.fromString(keys.salt));
  const account = (await wallet.getAccounts())[0].item;

  // Register the sponsored FPC (used as fallback).
  const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(0n) });
  await wallet.registerContract(fpc, SponsoredFPCContract.artifact);
  const sponsored = { paymentMethod: new SponsoredFeePaymentMethod(fpc.address) };
  const native = {}; // no paymentMethod => pay from the sender's own fee-juice balance

  const bal = await getFeeJuiceBalance(account, node as any);
  const claim = parseClaim();

  // bootstrapFee pays for the account-deploy tx; ongoingFee pays for the rest.
  // FEE_MODE=sponsored forces the shared FPC (e.g. right after refuelling it
  // while the deployer itself is broke); FEE_MODE=native forces native juice.
  const feeMode = process.env.FEE_MODE ?? 'auto';
  let bootstrapFee: any, ongoingFee: any, payer: string;
  if (feeMode === 'sponsored') {
    bootstrapFee = sponsored; ongoingFee = sponsored;
    payer = 'shared sponsored FPC (FEE_MODE=sponsored)';
  } else if (bal > 0n) {
    bootstrapFee = native; ongoingFee = native;
    payer = `native fee juice (balance ${bal})`;
  } else if (claim) {
    bootstrapFee = { paymentMethod: new FeeJuicePaymentMethodWithClaim(account, claim) };
    ongoingFee = native; // the claim credits the account, so later txs pay natively
    payer = `fee-juice claim (${claim.claimAmount}) then native`;
  } else {
    bootstrapFee = sponsored; ongoingFee = sponsored;
    payer = 'shared sponsored FPC (fallback)';
  }

  // Deploy the deployer account once. A positive fee-juice balance does NOT
  // prove the account contract exists: a chain reset leaves faucet credits on
  // an undeployed address. Ask the node for the instance; deploy when missing
  // (an "Existing nullifier" error still means already-deployed). Wait for the
  // deploy to be CHECKPOINTED so the account's signing-key note is syncable
  // before its first entrypoint tx (else "Failed to get a note").
  const instance = await (node as any).getContract(account).catch(() => undefined);
  if (instance) {
    console.log('deployer account already on-chain; skipping deploy.');
  } else {
    console.log(`deploying deployer account (paid by ${payer}) ...`);
    try {
      await (await manager.getDeployMethod()).send({ from: NO_FROM, fee: bootstrapFee, wait: { waitForStatus: 'checkpointed' as any } });
      console.log('  deployer account deployed (canonical).');
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/Existing nullifier|already.*(deploy|exist)/i.test(msg)) {
        console.log('  deployer account already on-chain (deploy skipped).');
      } else {
        throw e;
      }
    }
  }

  console.log(`deployer: ${account.toString()}\nfee payer: ${payer}`);
  return { wallet, account, manager, node, fee: ongoingFee };
}
