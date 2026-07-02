// =============================================================================
//  pay_browser_e2e.ts - the Option A finale: an UNKNOWN payer (the deployer)
//  pays the dApp's browser account and announces on the Beacon; the dApp's
//  payment watcher must then discover the payment BY ITSELF (scan tag ->
//  decrypt payer -> registerSender -> "Payment received").
// =============================================================================
//  The announce crypto mirrors dapp/src/aztec.ts announcePayment() exactly:
//    K   = Beacon.key_of(recipient)              (published by the recipient)
//    tag = poseidon2(poseidon2(K.x, K.y, DOM), 0)
//    E   = e*G ; S = e*K ; ct = payer + poseidon2(S.x, S.y, DOM) mod p
//
//  Env: RECIPIENT (browser account address), BEACON_ADDRESS, PAY_TOKEN_ADDRESS
//  (defaults read from dapp/.env), AMOUNT (base units, default 200e18).
//  Run (repo root, WSL):  bash run_pay_browser.sh
// =============================================================================
import { BeaconContract } from '../beacon/target/Beacon.js';
import { TokenContract } from '@aztec/noir-contracts.js/Token';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';
import { Grumpkin } from '@aztec/foundation/crypto/grumpkin';
import { GrumpkinScalar, Point } from '@aztec/foundation/curves/grumpkin';
import { setupDeployer } from './fees.js';
import fs from 'node:fs';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'https://v5.testnet.rpc.aztec-labs.com';
const DOMAIN = 0x747275n; // must match the dApp's BEACON_DOMAIN
const AMOUNT = BigInt(process.env.AMOUNT ?? (200n * 10n ** 18n).toString());
const CHECKPOINTED = { waitForStatus: 'checkpointed' as any };
const TRANSIENT = /dropped|P2P|timeout|propagat|reorg|fetch|Block hash|not ready|Failed to get a note/i;

function envVar(key: string): string {
  if (process.env[key]) return process.env[key]!;
  try { const m = fs.readFileSync('dapp/.env', 'utf-8').match(new RegExp(`^${key}=(.*)$`, 'm')); return m ? m[1].trim() : ''; } catch { return ''; }
}
const big = (v: any): bigint => {
  let x = v; if (x && typeof x === 'object' && 'result' in x) x = x.result;
  return BigInt((x && x.toString) ? x.toString() : x);
};
const sendWait = async (label: string, make: () => any, opts: any, tries = 4): Promise<void> => {
  for (let i = 1; i <= tries; i++) {
    try { const ix = await make(); await ix.send(opts); return; }
    catch (e: any) { const m = String(e?.message ?? e).split('\n')[0];
      if (i < tries && TRANSIENT.test(m)) { console.log(`  ${label}: retry ${i} (${m.slice(0, 50)})`); await new Promise(r => setTimeout(r, 4000)); continue; }
      throw e; }
  }
};

async function main() {
  const recipientStr = process.env.RECIPIENT;
  if (!recipientStr) throw new Error('set RECIPIENT (the browser account address)');
  const recipient = AztecAddress.fromStringUnsafe(recipientStr);
  const beaconAddr = AztecAddress.fromStringUnsafe(envVar('BEACON_ADDRESS'));
  const tokenAddr = AztecAddress.fromStringUnsafe(envVar('PAY_TOKEN_ADDRESS'));
  console.log(`paying ${recipient.toString().slice(0, 18)}… ${AMOUNT} base units + beacon announce\n`);

  const { wallet, account: payer, node, fee } = await setupDeployer(NODE_URL);
  try { const ti = await node.getContract(tokenAddr); if (ti) await wallet.registerContract(ti, TokenContract.artifact); } catch { /* known */ }
  try { const bi = await node.getContract(beaconAddr); if (bi) await wallet.registerContract(bi, BeaconContract.artifact); } catch { /* known */ }
  const token = await TokenContract.at(tokenAddr, wallet);
  const beacon = await BeaconContract.at(beaconAddr, wallet);

  // 1. Recipient's published beacon key (the dApp registered it automatically).
  const k: any = (await beacon.methods.key_of(recipient).simulate({ from: payer }) as any);
  const kv = (k && 'result' in k) ? k.result : k;
  const kx = big(kv.x), ky = big(kv.y);
  if (kx === 0n) throw new Error('recipient has NO beacon key published - is the dApp account deployed?');
  console.log('recipient beacon key found:', `(${kx.toString(16).slice(0, 10)}…, ${ky.toString(16).slice(0, 10)}…)`);

  // 2. Fund the payer with tokens (deployer is the token admin) + transfer.
  console.log(`minting ${AMOUNT * 2n} to the payer, then transferring ${AMOUNT} privately ...`);
  await sendWait('mint', () => token.methods.mint_to_private(payer, AMOUNT * 2n), { from: payer, fee, wait: CHECKPOINTED });
  await sendWait('transfer', () => token.methods.transfer(recipient, AMOUNT), { from: payer, fee, wait: CHECKPOINTED });

  // 3. Announce under the recipient's tag, payer encrypted to the beacon key.
  const K = new Point(new Fr(kx), new Fr(ky));
  const e = GrumpkinScalar.random();
  const E = await Grumpkin.mul(Grumpkin.generator, e);
  const S = await Grumpkin.mul(K, e);
  const mask = await poseidon2Hash([S.x, S.y, new Fr(DOMAIN)]);
  const ct = new Fr((payer.toBigInt() + mask.toBigInt()) % Fr.MODULUS);
  const tag = await poseidon2Hash([await poseidon2Hash([new Fr(kx), new Fr(ky), new Fr(DOMAIN)]), new Fr(0)]);
  console.log('announcing on the beacon (encrypted payer, recipient-derived tag) ...');
  await sendWait('announce', () => beacon.methods.announce(tag, E.x, E.y, ct), { from: payer, fee, wait: CHECKPOINTED });

  console.log('\nPAYER DONE - the payment is on-chain and announced.');
  console.log('The dApp should now discover it WITHOUT any manual action:');
  console.log('watch for the "Payment received" toast + balance bump.');
}

main().catch((e) => { console.error(e); process.exit(1); });
