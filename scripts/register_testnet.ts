// =============================================================================
//  register_testnet.ts - exercise the LIVE testnet AZNS contract.
// =============================================================================
//  Creates a sponsored account, runs the proof-gated register_first (stand-in
//  ZKPassport proof from zkp_data.json), then reads back state and does a
//  public set-target + resolve round-trip. Real proving is ON (required for
//  testnet), so each tx takes minutes.
//
//  Run:  AZNS_ADDRESS=0x... npm run register:testnet
//  (AZNS_ADDRESS defaults to the address in dapp/.env.)
// =============================================================================
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { NO_FROM } from '@aztec/aztec.js/account';
import { Fr } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { AZNSContract } from '../azns/target/AZNS.js';
import { nameHash, labelLength, MODE, normaliseName } from './lib.js';
import fs from 'node:fs';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'https://rpc.testnet.aztec-labs.com';

function aznsAddressFromEnvOrDotenv(): string {
  if (process.env.AZNS_ADDRESS) return process.env.AZNS_ADDRESS;
  const env = fs.readFileSync('dapp/.env', 'utf-8');
  const m = env.match(/AZNS_ADDRESS=(0x[0-9a-fA-F]+)/);
  if (!m) throw new Error('AZNS_ADDRESS not set and not found in dapp/.env');
  return m[1];
}

const toAddr = (v: any): AztecAddress =>
  AztecAddress.fromField(Fr.fromString((v && v.toString) ? v.toString() : String(v)));

async function main() {
  const zkp = JSON.parse(fs.readFileSync('zkp_data.json', 'utf-8'));
  const aznsAddr = aznsAddressFromEnvOrDotenv();
  const RAW = process.env.NAME ?? 'trudao';

  console.log(`testnet: ${NODE_URL}`);
  console.log(`AZNS:    ${aznsAddr}`);
  const wallet = await EmbeddedWallet.create(NODE_URL, { pxe: { proverEnabled: true } });
  const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(0n) });
  await wallet.registerContract(fpc, SponsoredFPCContract.artifact);
  const fee = { paymentMethod: new SponsoredFeePaymentMethod(fpc.address) };

  console.log('creating + deploying account (sponsored, real proof) ...');
  const manager = await wallet.createSchnorrAccount(Fr.random(), Fr.random());
  await (await manager.getDeployMethod()).send({ from: NO_FROM, fee });
  const account = (await wallet.getAccounts())[0].item;
  console.log(`account: ${account.toString()}`);

  const azns = await AZNSContract.at(AztecAddress.fromString(aznsAddr), wallet);
  const send = async (i: any) => { await i.send({ from: account, fee }); };
  const sim = async (i: any) => (await i.simulate({ from: account })).result;

  const nh = await nameHash(RAW);
  const len = labelLength(RAW);

  console.log(`\nregister_first "${normaliseName(RAW)}" (PUBLIC, 1y) with stand-in personhood proof ...`);
  await send(azns.methods.register_first(nh, len, account, 1, MODE.PUBLIC, zkp.vkAsFields, zkp.proofAsFields, zkp.publicInputs));
  console.log('  registered.');

  console.log('reading back state ...');
  console.log(`  is_verified(account) : ${await sim(azns.methods.is_verified(account))}`);
  console.log(`  owner_of(name)       : ${toAddr(await sim(azns.methods.owner_of(nh))).toString()}`);
  console.log(`  lease_status(name)   : ${await sim(azns.methods.lease_status(nh))}  (1 = active)`);

  console.log('\nset_public_target -> account, then resolve ...');
  await send(azns.methods.set_public_target(nh, account));
  const resolved = toAddr(await sim(azns.methods.resolve_public(nh)));
  console.log(`  resolve_public(name) : ${resolved.toString()}`);
  console.log(`  expected (account)   : ${account.toString()}`);
  console.log(resolved.equals(account) ? '\nLIVE TESTNET round-trip OK.' : '\nMISMATCH.');
}

main().catch((e) => { console.error(e); process.exit(1); });
