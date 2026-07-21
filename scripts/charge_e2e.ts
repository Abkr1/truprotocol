// =============================================================================
//  charge_e2e.ts - LIVE proof that registration fees are ENFORCED on-chain.
// =============================================================================
//  Self-contained end-to-end check against a real network (testnet by default).
//  It deploys a fresh test token + a charged AZNS whose treasury is a SEPARATE
//  in-wallet account (so the fee genuinely LEAVES the buyer), then proves the
//  fee is real by contrast:
//    1. with ZERO token balance, register must REVERT  (registration isn't free)
//    2. after minting, register SUCCEEDS, the name goes Active, and the buyer's
//       balance drops by EXACTLY the fee   (the fee left to the treasury)
//
//  Sends retry on transient testnet drops ("Tx dropped by P2P node"). This
//  validates the same contract bytecode the dApp uses; deploy_testnet.ts
//  deploys the dApp's own instance separately.
//
//  Run (repo root, WSL):  npm run charge:e2e
//  Needs the deployer funded for gas (scripts/fees.ts; `npm run fund:status`).
// =============================================================================
import { AZNSContract } from '../azns/target/AZNS.js';
import { TokenContract } from '@aztec/noir-contracts.js/Token';
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { setupDeployer } from './fees.js';
import { nameHash, packLabel, labelLength, MODE } from './lib.js';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'https://v5.testnet.rpc.aztec-labs.com';
const UNIT_PER_CENT = 1n;       // tiny fee for the test: $21/yr -> 2100 base units
const FEE_1YR_PUBLIC = 2100n;   // price_for_mode(PUBLIC)=2100 cents * 1yr * 1
const MINT_AMOUNT = FEE_1YR_PUBLIC * 100n; // generous, so a retried mint is harmless

// v5 .simulate() wraps the return value (e.g. { result }); unwrap robustly.
const big = (v: any): bigint => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' || typeof v === 'string') return BigInt(v);
  if (v && typeof v === 'object') {
    if ('result' in v) return big((v as any).result);
    if ('value' in v) return big((v as any).value);
    const s = typeof v.toString === 'function' ? v.toString() : '';
    if (s && s !== '[object Object]') return BigInt(s);
    throw new Error('big(): unexpected shape -> ' + JSON.stringify(v));
  }
  return BigInt(v);
};

async function main() {
  console.log(`charge E2E against: ${NODE_URL}`);
  const { wallet, account: buyer, fee } = await setupDeployer(NODE_URL);
  console.log('buyer (operator):', buyer.toString());

  // Retry sends across transient testnet drops; treat "already landed" as done.
  const sendWait = async (label: string, make: () => any, tries = 4): Promise<void> => {
    for (let i = 1; i <= tries; i++) {
      try { await make().send({ from: buyer, fee }); return; }
      catch (e: any) {
        const m = String(e?.message ?? e).split('\n')[0];
        if (/name registered or in grace|Existing nullifier/i.test(m)) { console.log(`  ${label}: already landed`); return; }
        if (i < tries && /dropped|P2P|timeout|propagat|reorg/i.test(m)) { console.log(`  ${label}: "${m.slice(0, 60)}" -> retry ${i}/${tries - 1}`); continue; }
        throw e;
      }
    }
  };

  // A separate treasury address (created in-wallet, never deployed - it only
  // RECEIVES the fee note), so the fee actually leaves the buyer.
  const tMgr = await wallet.createSchnorrAccount(Fr.random(), Fr.random());
  const treasury = (tMgr as any).address as AztecAddress;
  console.log('treasury        :', treasury.toString());

  console.log('\ndeploying test token (buyer = admin/minter) ...');
  const { contract: token } = await TokenContract
    .deploy(wallet, buyer, 'tru Charge Test', 'tCHG', 18)
    .send({ from: buyer, fee });
  console.log('token:', token.address.toString());

  console.log('deploying charged AZNS (treasury separate, unit_per_cent=1) ...');
  const { contract: azns } = await AZNSContract
    .deploy(wallet, token.address, treasury, UNIT_PER_CENT)
    .send({ from: buyer, fee });
  console.log('azns :', azns.address.toString());

  const balance = async () => big(await token.methods.balance_of_private(buyer).simulate({ from: buyer }));
  const label = 'chargetest' + Math.floor(Math.random() * 1e6);
  const nh = await nameHash(label);
  const len = labelLength(label);

  // --- 1. ZERO balance => register must REVERT (not free) ------------------
  console.log(`\nbuyer token balance: ${await balance()} (expect 0)`);
  console.log(`attempting register "${label}" with no tokens (expect REVERT) ...`);
  let revertedWhenBroke = false;
  try {
    await azns.methods.register(nh, packLabel(label), len, buyer, 1, MODE.PUBLIC, Fr.random()).send({ from: buyer, fee });
    console.log('  !! register SUCCEEDED with zero balance - FEE NOT ENFORCED');
  } catch (e: any) {
    revertedWhenBroke = true;
    console.log(`  reverted as expected: ${(e?.message ?? e).toString().split('\n')[0].slice(0, 140)}`);
  }

  // --- 2. mint, then register => SUCCEEDS and the fee leaves the buyer ------
  console.log(`\nminting ${MINT_AMOUNT} to buyer ...`);
  await sendWait('mint', () => token.methods.mint_to_private(buyer, MINT_AMOUNT));
  const before = await balance();
  console.log(`buyer token balance: ${before}`);
  console.log(`registering "${label}" with the fee (expect SUCCESS) ...`);
  await sendWait('register', () => azns.methods.register(nh, packLabel(label), len, buyer, 1, MODE.PUBLIC, Fr.random()));

  const owner = await azns.methods.owner_of(nh).simulate({ from: buyer });
  const status = big(await azns.methods.lease_status(nh).simulate({ from: buyer }));
  const after = await balance();
  const charged = before - after;
  console.log(`\nafter register: owner=${big(owner) === big(buyer) ? 'buyer' : owner.toString()} status=${status} balance=${after} (charged ${charged})`);

  const ownerOk = big(owner) === big(buyer);
  const activeOk = status === 1n;
  const chargedOk = charged === FEE_1YR_PUBLIC;
  const pass = revertedWhenBroke && ownerOk && activeOk && chargedOk;
  console.log('\n--- RESULT ---');
  console.log(`  reverts at 0 balance : ${revertedWhenBroke ? 'PASS' : 'FAIL'}`);
  console.log(`  registers when paid  : ${ownerOk && activeOk ? 'PASS' : 'FAIL'}`);
  console.log(`  fee charged exactly  : ${chargedOk ? 'PASS' : 'FAIL'} (charged ${charged}, expected ${FEE_1YR_PUBLIC})`);
  console.log(`  FEE ENFORCED E2E     : ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
