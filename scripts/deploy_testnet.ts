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
import { AZNSContract } from '../azns/target/AZNS.js';
import { setupDeployer } from './fees.js';
import fs from 'node:fs';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'https://rpc.testnet.aztec-labs.com';

async function main() {
  if (!fs.existsSync('zkp_data.json')) {
    console.error('zkp_data.json not found - run `npm run genproof` first.');
    process.exit(1);
  }
  const zkp = JSON.parse(fs.readFileSync('zkp_data.json', 'utf-8'));

  console.log(`connecting to testnet: ${NODE_URL}`);
  // Stable deployer + automatic fee selection (native fee juice / claim / FPC).
  // setupDeployer also deploys the deployer account on-chain if needed.
  const { wallet, account, fee } = await setupDeployer(NODE_URL);

  console.log('deploying AZNS ...');
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
