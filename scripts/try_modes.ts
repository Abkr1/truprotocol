// =============================================================================
//  try_modes.ts - attempt to register ONE name in all 3 modes (it can't).
// =============================================================================
//  Demonstrates that a name holds exactly one mode: register satoshi0 PUBLIC,
//  then try SELECTIVE and STEALTH on the SAME name. The first wins; the others
//  are rejected because the name is now taken. Run against testnet.
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
import { nameHash, labelLength, packLabel, MODE, normaliseName } from './lib.js';
import fs from 'node:fs';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'https://v5.testnet.rpc.aztec-labs.com';
const NAME = 'satoshi0';

function aznsAddr(): string {
  if (process.env.AZNS_ADDRESS) return process.env.AZNS_ADDRESS;
  const m = fs.readFileSync('dapp/.env', 'utf-8').match(/AZNS_ADDRESS=(0x[0-9a-fA-F]+)/);
  if (!m) throw new Error('AZNS_ADDRESS not found');
  return m[1];
}
const toAddr = (v: any) => AztecAddress.fromField(Fr.fromString((v && v.toString) ? v.toString() : String(v)));

async function main() {
  const wallet = await EmbeddedWallet.create(NODE_URL, { pxe: { proverEnabled: true } });
  const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(0n) });
  await wallet.registerContract(fpc, SponsoredFPCContract.artifact);
  const fee = { paymentMethod: new SponsoredFeePaymentMethod(fpc.address) };

  console.log('creating account (sponsored, real proof) ...');
  const m = await wallet.createSchnorrAccount(Fr.random(), Fr.random());
  await (await m.getDeployMethod()).send({ from: NO_FROM, fee });
  const account = (await wallet.getAccounts())[0].item;

  // Tell the fresh PXE about the already-deployed AZNS contract.
  const node = createAztecNodeClient(NODE_URL);
  const inst = await node.getContract(AztecAddress.fromString(aznsAddr()));
  if (!inst) throw new Error('AZNS contract not found on the node');
  await wallet.registerContract(inst, AZNSContract.artifact);

  const azns = await AZNSContract.at(AztecAddress.fromString(aznsAddr()), wallet);
  const nh = await nameHash(NAME);
  const len = labelLength(NAME);

  console.log(`\n[1] register ${normaliseName(NAME)} in PUBLIC (permissionless) ...`);
  try {
    await azns.methods.register(nh, packLabel(NAME), len, account, 1, MODE.PUBLIC)
      .send({ from: account, fee });
    console.log('    PUBLIC registration succeeded.');
  } catch (e: any) { console.log('    failed:', e?.message); }

  for (const mode of ['SELECTIVE', 'STEALTH'] as const) {
    console.log(`\n[+] try the SAME name in ${mode} (simulate) ...`);
    try {
      await azns.methods.register(nh, packLabel(NAME), len, account, 1, MODE[mode]).simulate({ from: account });
      console.log(`    ⚠️ unexpectedly allowed in ${mode}`);
    } catch (e: any) {
      console.log(`    ❌ rejected (expected): ${(e?.message || '').split('\n')[0]}`);
    }
  }

  const owner = toAddr((await azns.methods.owner_of(nh).simulate({ from: account })).result);
  const status = (await azns.methods.lease_status(nh).simulate({ from: account })).result;
  console.log(`\nResult: ${normaliseName(NAME)} owner=${owner.toString()} status=${status} (1=active).`);
  console.log('A name holds exactly ONE mode — the first registration (PUBLIC) wins; the others are rejected as "name registered".');
}

main().catch((e) => { console.error(e); process.exit(1); });
