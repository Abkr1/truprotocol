// =============================================================================
//  discovery_e2e.ts - PROVES the core primitive behind both discovery options:
//  a recipient in a SEPARATE PXE cannot see an incoming private transfer until
//  it registerSender(payer) -- and CAN once it does (historical re-scan works).
// =============================================================================
//  This is the foundation of "discover a payment without knowing the sender":
//  both Option A (on-chain beacon) and Option B (off-chain relay) end by handing
//  the recipient the payer address so it can registerSender() + see the balance.
//  If registerSender did NOT reveal a HISTORICAL note, both options would break.
//
//    Sender S    = funded deployer (token admin/minter), its own PXE.
//    Recipient R = fresh account in an INDEPENDENT ephemeral PXE (never saw S's tx).
//    Steps: deploy token -> deploy R -> S mints to S -> S transfers to R
//           -> R.balance (expect 0, undiscovered) -> R.registerSender(S)
//           -> R.balance (expect the amount, discovered).
//
//  Run (repo root, WSL):  bash run_discovery.sh
// =============================================================================
import { TokenContract } from '@aztec/noir-contracts.js/Token';
import { Fr } from '@aztec/aztec.js/fields';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { setupDeployer, tolerantNode } from './fees.js';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'https://v5.testnet.rpc.aztec-labs.com';
const MINT = 1000n;
const SEND = 500n;
const CHECKPOINTED = { waitForStatus: 'checkpointed' as any };
const TRANSIENT = /dropped|P2P|timeout|propagat|reorg|fetch|Block hash|not ready|Failed to get a note/i;

const big = (v: any): bigint => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' || typeof v === 'string') return BigInt(v);
  if (v && typeof v === 'object') {
    if ('result' in v) return big((v as any).result);
    if ('value' in v) return big((v as any).value);
    const s = typeof v.toString === 'function' ? v.toString() : '';
    if (s && s !== '[object Object]') return BigInt(s);
  }
  return BigInt(v);
};

// Retry a send across transient testnet drops; treat "already landed" as done.
// `make` builds a FRESH interaction each try (may be async, e.g. getDeployMethod).
const sendWait = async (label: string, make: () => any, opts: any, tries = 4): Promise<void> => {
  for (let i = 1; i <= tries; i++) {
    try { const ix = await make(); await ix.send(opts); return; }
    catch (e: any) {
      const m = String(e?.message ?? e).split('\n')[0];
      if (/Existing nullifier|already.*(deploy|exist)/i.test(m)) { console.log(`  ${label}: already landed`); return; }
      if (i < tries && TRANSIENT.test(m)) { console.log(`  ${label}: "${m.slice(0, 70)}" -> retry ${i}/${tries - 1}`); await new Promise(r => setTimeout(r, 4000)); continue; }
      throw e;
    }
  }
};

async function main() {
  console.log(`discovery E2E against: ${NODE_URL}\n`);

  // ---- Sender S: funded deployer (token admin/minter) ---------------------
  const { wallet: S, account: sender, fee } = await setupDeployer(NODE_URL);
  console.log('sender   (S):', sender.toString());

  console.log('\ndeploying fresh test token (S = admin/minter), waiting canonical ...');
  let token: any;
  for (let i = 1; i <= 4; i++) {
    try { ({ contract: token } = await TokenContract.deploy(S, sender, 'tru Discovery Test', 'tDISC', 18).send({ from: sender, fee, wait: CHECKPOINTED })); break; }
    catch (e: any) { const m = String(e?.message ?? e).split('\n')[0]; if (i < 4 && TRANSIENT.test(m)) { console.log(`  token deploy retry ${i}: ${m.slice(0, 60)}`); await new Promise(r => setTimeout(r, 4000)); continue; } throw e; }
  }
  const tokenAddr = token.address;
  console.log('token       :', tokenAddr.toString());

  // ---- Recipient R: INDEPENDENT ephemeral PXE (this is the whole point) ----
  // R is NEVER deployed on-chain: receiving notes and reading balances need no
  // account contract (only tx SENDERS do), so R needs no fees at all.
  console.log('\ncreating recipient R in a separate ephemeral PXE (no on-chain deploy) ...');
  const R = await EmbeddedWallet.create(tolerantNode(NODE_URL), { pxe: { proverEnabled: true }, ephemeral: true });
  await R.createSchnorrAccount(Fr.random(), Fr.random());
  const recipient = (await R.getAccounts())[0].item;
  console.log('recipient(R):', recipient.toString());

  // Register the token instance in R's PXE (fetched from the node; R never deployed it).
  const node = tolerantNode(NODE_URL);
  const tinst = await node.getContract(tokenAddr);
  if (!tinst) throw new Error('token instance not canonical on the node yet');
  await R.registerContract(tinst, TokenContract.artifact);

  // ---- S mints to itself (own tx), then transfers to R --------------------
  console.log(`\nS mints ${MINT} to itself ...`);
  await sendWait('mint', () => token.methods.mint_to_private(sender, MINT), { from: sender, fee, wait: CHECKPOINTED });
  console.log(`S transfers ${SEND} to R (private), waiting canonical ...`);
  await sendWait('transfer', () => token.methods.transfer(recipient, SEND), { from: sender, fee, wait: CHECKPOINTED });

  // ---- R checks BEFORE registering the sender -----------------------------
  const tokenAtR = await TokenContract.at(tokenAddr, R);
  const rBal = async () => big(await tokenAtR.methods.balance_of_private(recipient).simulate({ from: recipient }));
  const before = await rBal();
  console.log(`\nR balance BEFORE registerSender: ${before}   (expect 0 - undiscovered)`);

  // ---- R registers the sender, re-syncs, re-checks ------------------------
  console.log('R.registerSender(S) + re-sync ...');
  await R.registerSender(sender);
  let after = await rBal();
  if (after !== SEND) { await new Promise(r => setTimeout(r, 6000)); after = await rBal(); } // give the re-scan a beat
  console.log(`R balance AFTER  registerSender: ${after}   (expect ${SEND} - discovered)`);

  const pass = before === 0n && after === SEND;
  console.log('\n--- RESULT ---');
  console.log(`  hidden before registerSender : ${before === 0n ? 'PASS' : 'FAIL'} (${before})`);
  console.log(`  revealed after registerSender: ${after === SEND ? 'PASS' : 'FAIL'} (${after})`);
  console.log(`  DISCOVERY PRIMITIVE          : ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
