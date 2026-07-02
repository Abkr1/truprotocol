// =============================================================================
//  beacon_a_e2e.ts - OPTION A: on-chain discovery beacon, recipient-derivable
//  tags. Proves a recipient discovers an incoming private payment WITHOUT
//  knowing the sender and WITHOUT any off-chain channel.
// =============================================================================
//  Alongside the payment, the payer calls Beacon.announce(tag, payer, marker)
//  where tag = poseidon2(beacon_secret(R), index) is computable by ANYONE from
//  R's public beacon key (spike: derived from R's address; prod: R's published
//  stealth/beacon meta-key). The kernel silos the tag with the Beacon address;
//  R computes the SAME siloed tag with identical stdlib code, fetches the log
//  straight from the node (getPrivateLogsByTags - no PXE, no sender!), reads
//  the payer, registerSender(payer) -> the payment note appears.
//
//  Both sides use the same @aztec/stdlib primitives, so there is no hash
//  mirroring to get wrong: Tag(poseidon2) + SiloedTag.computeFromTagAndApp.
//
//  Run (repo root, WSL):  bash run_beacon_a.sh   (needs beacon compiled first:
//  bash run_beacon_build.sh)
// =============================================================================
import { BeaconContract } from '../beacon/target/Beacon.js';
import { TokenContract } from '@aztec/noir-contracts.js/Token';
import { Fr } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';
import { Tag, SiloedTag } from '@aztec/stdlib/logs';
import { setupDeployer, tolerantNode } from './fees.js';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'https://v5.testnet.rpc.aztec-labs.com';
const MINT = 1000n, SEND = 500n;
const MARKER = 0x74727542n; // "truB" - spike payload marker
const CHECKPOINTED = { waitForStatus: 'checkpointed' as any };
const TRANSIENT = /dropped|P2P|timeout|propagat|reorg|fetch|Block hash|not ready|Failed to get a note/i;

const big = (v: any): bigint => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' || typeof v === 'string') return BigInt(v);
  if (v && typeof v === 'object') { if ('result' in v) return big(v.result); if ('value' in v) return big(v.value); const s = v.toString?.() ?? ''; if (s && s !== '[object Object]') return BigInt(s); }
  return BigInt(v);
};
const sendWait = async (label: string, make: () => any, opts: any, tries = 4): Promise<void> => {
  for (let i = 1; i <= tries; i++) {
    try { const ix = await make(); await ix.send(opts); return; }
    catch (e: any) { const m = String(e?.message ?? e).split('\n')[0];
      if (/Existing nullifier|already.*(deploy|exist)/i.test(m)) { console.log(`  ${label}: already landed`); return; }
      if (i < tries && TRANSIENT.test(m)) { console.log(`  ${label}: retry ${i} (${m.slice(0, 50)})`); await new Promise(r => setTimeout(r, 4000)); continue; }
      throw e; }
  }
};

/** The beacon tag scheme, shared verbatim by payer and recipient.
 *  beacon_secret is derivable from the recipient's PUBLIC beacon key - here its
 *  address (spike); prod: its published stealth/beacon meta-key. */
async function beaconSecret(recipient: AztecAddress): Promise<Fr> {
  return poseidon2Hash([recipient.toField(), new Fr(MARKER)]);
}
async function beaconRawTag(recipient: AztecAddress, index: number): Promise<Fr> {
  // Byte-identical to stdlib Tag.compute: poseidon2([secret, index]).
  return poseidon2Hash([await beaconSecret(recipient), index]);
}
async function beaconSiloedTag(recipient: AztecAddress, beacon: AztecAddress, index: number): Promise<SiloedTag> {
  return SiloedTag.computeFromTagAndApp(new Tag(await beaconRawTag(recipient, index)), beacon);
}

async function main() {
  console.log(`OPTION A (on-chain beacon) against: ${NODE_URL}\n`);
  const { wallet: S, account: sender, fee } = await setupDeployer(NODE_URL);
  console.log('sender   (S):', sender.toString());

  console.log('\ndeploying token + beacon, waiting canonical ...');
  let token: any, beacon: any;
  for (let i = 1; i <= 4; i++) { try { ({ contract: token } = await TokenContract.deploy(S, sender, 'tru Beacon A', 'tBA', 18).send({ from: sender, fee, wait: CHECKPOINTED })); break; } catch (e: any) { if (i < 4 && TRANSIENT.test(String(e?.message ?? e))) { await new Promise(r => setTimeout(r, 4000)); continue; } throw e; } }
  console.log('token :', token.address.toString());
  for (let i = 1; i <= 4; i++) { try { ({ contract: beacon } = await BeaconContract.deploy(S).send({ from: sender, fee, wait: CHECKPOINTED })); break; } catch (e: any) { if (i < 4 && TRANSIENT.test(String(e?.message ?? e))) { await new Promise(r => setTimeout(r, 4000)); continue; } throw e; } }
  console.log('beacon:', beacon.address.toString());

  // R: separate ephemeral PXE, never deployed, zero knowledge of the sender.
  const R = await EmbeddedWallet.create(tolerantNode(NODE_URL), { pxe: { proverEnabled: true }, ephemeral: true });
  await R.createSchnorrAccount(Fr.random(), Fr.random());
  const recipient = (await R.getAccounts())[0].item;
  console.log('recipient(R):', recipient.toString());
  const node = tolerantNode(NODE_URL);
  await R.registerContract((await node.getContract(token.address))!, TokenContract.artifact);

  console.log(`\nS mints ${MINT}, transfers ${SEND} to R, announces on the beacon ...`);
  await sendWait('mint', () => token.methods.mint_to_private(sender, MINT), { from: sender, fee, wait: CHECKPOINTED });
  await sendWait('transfer', () => token.methods.transfer(recipient, SEND), { from: sender, fee, wait: CHECKPOINTED });
  // The payer derives R's beacon tag from R's PUBLIC key material only.
  const rawTag = await beaconRawTag(recipient, 0);
  await sendWait('announce', () => beacon.methods.announce(rawTag, sender.toField(), new Fr(MARKER)), { from: sender, fee, wait: CHECKPOINTED });

  // ---- R side: no sender knowledge, no off-chain channel -------------------
  const tokenAtR = await TokenContract.at(token.address, R);
  const rBal = async () => big(await tokenAtR.methods.balance_of_private(recipient).simulate({ from: recipient }));
  const before = await rBal();
  console.log(`\nR balance BEFORE beacon scan: ${before}   (expect 0)`);

  // R computes ITS OWN siloed tag (needs only its key + the beacon address,
  // which is public app config) and asks the node for logs under it.
  const siloed = await beaconSiloedTag(recipient, beacon.address, 0);
  const results: any[][] = await node.getPrivateLogsByTags({ tags: [siloed] });
  const logs = results[0] ?? [];
  console.log(`R queried getPrivateLogsByTags -> ${logs.length} log(s) under its beacon tag`);
  let discovered = 0;
  for (const log of logs) {
    const fields: any[] = log.logData ?? [];
    // logData carries the tag in field 0; payload starts at 1: [payer, marker].
    const payerF = fields[1], markerF = fields[2];
    if (!payerF || BigInt(markerF?.toString?.() ?? 0) !== MARKER) continue;
    const payer = AztecAddress.fromStringUnsafe(payerF.toString());
    console.log('  beacon payload -> payer:', payer.toString().slice(0, 18) + '…');
    await R.registerSender(payer);
    discovered++;
  }
  let after = await rBal();
  if (after !== SEND && discovered > 0) { await new Promise(r => setTimeout(r, 6000)); after = await rBal(); }
  console.log(`R balance AFTER  beacon+registerSender: ${after}   (expect ${SEND})`);

  const pass = before === 0n && discovered > 0 && after === SEND;
  console.log('\n--- RESULT (Option A) ---');
  console.log(`  log found by recipient-derived tag : ${logs.length > 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  payer learned from beacon payload  : ${discovered > 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  payment discovered                 : ${after === SEND ? 'PASS' : 'FAIL'} (${after})`);
  console.log(`  OPTION A END-TO-END                : ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
