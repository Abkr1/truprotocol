// =============================================================================
//  deploy_mainnet.ts - STRICT mainnet deploy of AZNS (audit item 2).
// =============================================================================
//  Unlike deploy_testnet.ts, this script refuses to run with testnet
//  placeholders. It enforces the mainnet checklist in CODE so a mis-deploy
//  can't happen by accident:
//    - a real stablecoin PAY_TOKEN_ADDRESS the operator does NOT mint (no test
//      token is ever deployed here);
//    - a dedicated TREASURY_ADDRESS that is NOT the deployer (treasury is
//      immutable — no setter — so a wrong value means redeploying);
//    - an explicit UNIT_PER_CENT (no silent default);
//    - the node's L1 must be Ethereum mainnet (chainId 1);
//    - an explicit CONFIRM_MAINNET=1 acknowledgement.
//  It NEVER deploys the open-mint faucet (that mints unlimited tokens — it must
//  never touch a real token). It writes dapp/.env.mainnet (a SEPARATE file) so
//  the live dapp/.env is never clobbered automatically.
//
//  Run (repo root, WSL), all vars required:
//    AZTEC_NODE_URL=<aztec mainnet node> \
//    PAY_TOKEN_ADDRESS=0x<real stablecoin> \
//    TREASURY_ADDRESS=0x<cold/multisig, != deployer> \
//    UNIT_PER_CENT=<e.g. 10000000000000000 for an 18-decimal $1 token> \
//    CONFIRM_MAINNET=1 npm run deploy:mainnet
// =============================================================================
import { AZNSContract } from '../azns/target/AZNS.js';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { setupDeployer } from './fees.js';
import fs from 'node:fs';

const NODE_URL = process.env.AZTEC_NODE_URL ?? '';
const PAY_TOKEN_ADDRESS = process.env.PAY_TOKEN_ADDRESS ?? '';
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS ?? '';
const UNIT_PER_CENT = process.env.UNIT_PER_CENT ?? '';
const CONFIRM = process.env.CONFIRM_MAINNET === '1';
// Escape hatch for a mainnet-SHAPED staging chain (same client stack, not L1=1).
const ALLOW_NONMAINNET = process.env.ALLOW_NONMAINNET === '1';

function fail(msg: string): never {
  console.error(`\n[deploy:mainnet] REFUSING TO DEPLOY: ${msg}\n`);
  process.exit(1);
}

async function main() {
  // ---- gate on explicit, non-placeholder configuration --------------------
  if (!NODE_URL) fail('AZTEC_NODE_URL must point at your Aztec mainnet node.');
  if (!CONFIRM) fail('set CONFIRM_MAINNET=1 to acknowledge this is a real-money mainnet deploy.');
  if (!PAY_TOKEN_ADDRESS) {
    fail('PAY_TOKEN_ADDRESS must be a real stablecoin you do NOT control the mint of. This script never deploys a test token.');
  }
  if (!TREASURY_ADDRESS) {
    fail('TREASURY_ADDRESS must be a dedicated cold/multisig treasury (never the deployer). It is set immutably — there is no change-treasury function.');
  }
  if (!UNIT_PER_CENT) {
    fail('UNIT_PER_CENT must be set explicitly (no default). For an 18-decimal USD-pegged token use 10000000000000000 (1e16).');
  }
  let unitPerCent: bigint;
  try { unitPerCent = BigInt(UNIT_PER_CENT); } catch { fail(`UNIT_PER_CENT=${UNIT_PER_CENT} is not an integer.`); }
  if (unitPerCent! <= 0n) fail('UNIT_PER_CENT must be greater than zero.');

  const { wallet, account, node, fee } = await setupDeployer(NODE_URL);

  // ---- assert the node is actually Ethereum-mainnet L1 (Aztec mainnet) -----
  let l1 = 0;
  try {
    const info: any = await (node as any).getNodeInfo();
    l1 = Number(info?.l1ChainId ?? info?.l1?.chainId ?? 0);
  } catch { /* limited node RPC */ }
  if (l1 !== 1 && !ALLOW_NONMAINNET) {
    fail(`node L1 chainId ${l1 || 'unknown'} is not Ethereum mainnet (1). Point AZTEC_NODE_URL at Aztec mainnet, or set ALLOW_NONMAINNET=1 for a mainnet-shaped staging network.`);
  }

  const token = AztecAddress.fromStringUnsafe(PAY_TOKEN_ADDRESS);
  const treasury = AztecAddress.fromStringUnsafe(TREASURY_ADDRESS);
  if (treasury.toString() === account.toString()) {
    fail('TREASURY_ADDRESS equals the deployer account. Fees are pulled to the treasury; use a dedicated cold/multisig address distinct from the (hot) deployer.');
  }

  // ---- summary + pricing sanity line (operator eyeballs this) ---------------
  const perYear = 2100n * unitPerCent; // flat $21/yr = 2100 cents
  console.log('\n=== MAINNET AZNS DEPLOY ===');
  console.log(`  node:          ${NODE_URL} (L1 chainId ${l1 || 'unknown'})`);
  console.log(`  deployer:      ${account.toString()}`);
  console.log(`  payment token: ${token.toString()}`);
  console.log(`  treasury:      ${treasury.toString()}`);
  console.log(`  unit/cent:     ${unitPerCent}`);
  console.log(`  => $21/yr fee = ${perYear} base units. For an N-decimal $1-pegged token this must equal 21 * 10^N (18-dec: 21000000000000000000). VERIFY against your token's decimals.`);
  console.log('  faucet:        NOT deployed (open-mint faucet must never mint a real token)\n');

  // ---- deploy --------------------------------------------------------------
  console.log('deploying AZNS to mainnet ...');
  const { contract: azns } = await AZNSContract
    .deploy(wallet, token, treasury, unitPerCent)
    .send({ from: account, fee, wait: { waitForStatus: 'checkpointed' as any } });
  const addr = azns.address.toString();
  console.log(`\nAZNS deployed on MAINNET at: ${addr}`);

  // Write a SEPARATE env file; never clobber the working dapp/.env automatically.
  const out = [
    `AZTEC_NODE_URL=${NODE_URL}`,
    `AZNS_ADDRESS=${addr}`,
    `PAY_TOKEN_ADDRESS=${token.toString()}`,
    '# No FAUCET_ADDRESS on mainnet (registrants hold the real token).',
    '# Deploy the beacon separately if payment discovery is wanted, then set BEACON_ADDRESS.',
    '',
  ].join('\n');
  fs.writeFileSync('dapp/.env.mainnet', out);
  console.log('\nwrote dapp/.env.mainnet — review it, then copy to dapp/.env deliberately when you are ready to point the dApp at mainnet.');
  console.log('Reminder: run a full external security audit before directing real value here.');
}

main().catch((e) => { console.error(e); process.exit(1); });
