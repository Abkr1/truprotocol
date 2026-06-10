// =============================================================================
//  deploy_testnet.ts - deploy AZNS to the Aztec public testnet.
// =============================================================================
//  Creates (and deploys) a fresh Schnorr account paid for by the canonical
//  sponsored FPC, then deploys AZNS pinned to the stand-in personhood vkHash
//  from zkp_data.json. Writes the resulting node URL + contract address into
//  dapp/.env so the dApp connects to the live testnet deployment.
//
//  Run (from repo root, inside WSL):
//    npm run genproof                # if zkp_data.json is missing
//    npm run deploy:testnet
//
//  Testnet node + version: https://rpc.testnet.aztec-labs.com (aztec 4.3.1).
// =============================================================================
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { NO_FROM } from '@aztec/aztec.js/account';
import { Fr } from '@aztec/aztec.js/fields';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { AZNSContract } from '../azns/target/AZNS.js';
import fs from 'node:fs';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'https://rpc.testnet.aztec-labs.com';

async function main() {
  if (!fs.existsSync('zkp_data.json')) {
    console.error('zkp_data.json not found - run `npm run genproof` first.');
    process.exit(1);
  }
  const zkp = JSON.parse(fs.readFileSync('zkp_data.json', 'utf-8'));

  console.log(`connecting to testnet: ${NODE_URL}`);
  // proverEnabled:true => REAL bb proofs (default is false = fake proofs, which
  // a local network accepts but testnet rejects as "Invalid proof").
  const wallet = await EmbeddedWallet.create(NODE_URL, { pxe: { proverEnabled: true } });

  // Canonical sponsored FPC pays fees (deterministic salt-0 instance).
  const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(0n) });
  await wallet.registerContract(fpc, SponsoredFPCContract.artifact);
  const fee = { paymentMethod: new SponsoredFeePaymentMethod(fpc.address) };
  console.log(`sponsored FPC: ${fpc.address.toString()}`);

  console.log('creating + deploying account (sponsored) ...');
  const manager = await wallet.createSchnorrAccount(Fr.random(), Fr.random());
  const dm = await manager.getDeployMethod();
  await dm.send({ from: NO_FROM, fee });
  const accounts = await wallet.getAccounts();
  const account = accounts[0].item;
  console.log(`account: ${account.toString()}`);

  console.log('deploying AZNS (sponsored) ...');
  const { contract: azns } = await AZNSContract.deploy(wallet, zkp.vkHash).send({ from: account, fee });
  const addr = azns.address.toString();
  console.log(`\nAZNS deployed on testnet at: ${addr}`);

  // Wire the dApp to this deployment.
  const env = `AZTEC_NODE_URL=${NODE_URL}\nAZNS_ADDRESS=${addr}\n`;
  fs.writeFileSync('dapp/.env', env);
  console.log('\nwrote dapp/.env:\n' + env);
  console.log('Run the dApp against testnet:  cd dapp && npm run dev');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
