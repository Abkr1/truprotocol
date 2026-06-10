// =============================================================================
//  reg_verify.ts - register a PUBLIC name and verify it resolves to its owner
//  by DEFAULT (no set_public_target step). Then repoint it to prove the owner
//  can still change it. Run against testnet (or AZTEC_NODE_URL).
//  Usage: NAME=satoshi0 npm run reg:verify
// =============================================================================
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { NO_FROM } from '@aztec/aztec.js/account';
import { Fr } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { AZNSContract } from '../azns/target/AZNS.js';
import { nameHash, labelLength, MODE, normaliseName } from './lib.js';
import fs from 'node:fs';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'https://rpc.testnet.aztec-labs.com';
const NAME = process.env.NAME ?? 'satoshi0';

function aznsAddr(): string {
  if (process.env.AZNS_ADDRESS) return process.env.AZNS_ADDRESS;
  const m = fs.readFileSync('dapp/.env', 'utf-8').match(/AZNS_ADDRESS=(0x[0-9a-fA-F]+)/);
  if (!m) throw new Error('AZNS_ADDRESS not found');
  return m[1];
}
const toAddr = (v: any) => AztecAddress.fromField(Fr.fromString((v && v.toString) ? v.toString() : String(v)));

async function main() {
  const zkp = JSON.parse(fs.readFileSync('zkp_data.json', 'utf-8'));
  const wallet = await EmbeddedWallet.create(NODE_URL, { pxe: { proverEnabled: !/localhost|127\.0\.0\.1/.test(NODE_URL) } });
  const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(0n) });
  await wallet.registerContract(fpc, SponsoredFPCContract.artifact);
  const fee = { paymentMethod: new SponsoredFeePaymentMethod(fpc.address) };

  console.log(`node: ${NODE_URL}\nAZNS: ${aznsAddr()}`);
  console.log('creating account (sponsored, real proof) ...');
  const m = await wallet.createSchnorrAccount(Fr.random(), Fr.random());
  await (await m.getDeployMethod()).send({ from: NO_FROM, fee });
  const account = (await wallet.getAccounts())[0].item;
  console.log(`account: ${account.toString()}`);

  const node = createAztecNodeClient(NODE_URL);
  const inst = await node.getContract(AztecAddress.fromString(aznsAddr()));
  if (!inst) throw new Error('AZNS contract not found on the node');
  await wallet.registerContract(inst, AZNSContract.artifact);
  const azns = await AZNSContract.at(AztecAddress.fromString(aznsAddr()), wallet);

  const nh = await nameHash(NAME);
  const toFr = (xs: string[]) => xs.map((x) => Fr.fromString(x));

  console.log(`\n[1] register ${normaliseName(NAME)} PUBLIC (no set-address step afterwards) ...`);
  await azns.methods
    .register_first(nh, labelLength(NAME), account, 1, MODE.PUBLIC, toFr(zkp.vkAsFields), toFr(zkp.proofAsFields), toFr(zkp.publicInputs))
    .send({ from: account, fee });
  console.log('    registered.');

  console.log('[2] resolve immediately (default target) ...');
  const resolved = toAddr((await azns.methods.resolve_public(nh).simulate({ from: account })).result);
  console.log(`    resolve_public -> ${resolved.toString()}`);
  console.log(`    owner          -> ${account.toString()}`);
  if (!resolved.equals(account)) throw new Error('DEFAULT RESOLUTION FAILED: did not resolve to owner');
  console.log('    ✅ resolves to the registrant by default.');

  console.log('[3] owner repoints the name (still allowed) ...');
  const other = AztecAddress.fromField(new Fr(424242n));
  await azns.methods.set_public_target(nh, other).send({ from: account, fee });
  const re = toAddr((await azns.methods.resolve_public(nh).simulate({ from: account })).result);
  console.log(`    resolve_public -> ${re.toString()}`);
  if (!re.equals(other)) throw new Error('REPOINT FAILED');
  console.log('    ✅ owner repointed successfully.');

  console.log(`\nALL OK: ${normaliseName(NAME)} resolves to its owner by default, and stays repointable.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
