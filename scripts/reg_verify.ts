// =============================================================================
//  reg_verify.ts - register a PUBLIC name and verify it resolves to its owner
//  by DEFAULT (no set_public_target step). Then repoint it to prove the owner
//  can still change it. Run against testnet (or AZTEC_NODE_URL).
//  Usage: NAME=satoshi0 npm run reg:verify
// =============================================================================
import { Fr } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { AZNSContract } from '../azns/target/AZNS.js';
import { setupDeployer } from './fees.js';
import { nameHash, labelLength, packLabel, MODE, normaliseName } from './lib.js';
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
  console.log(`node: ${NODE_URL}\nAZNS: ${aznsAddr()}`);
  // setupDeployer connects + deploys the deployer account on-chain if needed.
  const { wallet, account, node, fee } = await setupDeployer(NODE_URL);

  const inst = await node.getContract(AztecAddress.fromString(aznsAddr()));
  if (!inst) throw new Error('AZNS contract not found on the node');
  await wallet.registerContract(inst, AZNSContract.artifact);
  const azns = await AZNSContract.at(AztecAddress.fromString(aznsAddr()), wallet);

  const nh = await nameHash(NAME);
  console.log(`\n[1] register ${normaliseName(NAME)} PUBLIC (permissionless, no proof) ...`);
  await azns.methods
    .register(nh, packLabel(NAME), labelLength(NAME), account, 1, MODE.PUBLIC)
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
