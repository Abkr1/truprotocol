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
  console.log(`connecting to testnet: ${NODE_URL}`);
  // Stable deployer + automatic fee selection (native fee juice / claim / FPC).
  // setupDeployer also deploys the deployer account on-chain if needed.
  const { wallet, account, fee } = await setupDeployer(NODE_URL);

  console.log('deploying AZNS (permissionless registration) ...');
  const { contract: azns } = await AZNSContract.deploy(wallet).send({ from: account, fee });
  const addr = azns.address.toString();
  console.log(`\nAZNS deployed on testnet at: ${addr}`);

  // Wire the dApp to this deployment. MERGE into dapp/.env: replace only our
  // two keys and keep everything else (e.g. the DAPP_WALLET_* house wallet).
  let env = '';
  try { env = fs.readFileSync('dapp/.env', 'utf-8'); } catch { /* fresh file */ }
  const setVar = (src: string, key: string, val: string) => {
    const line = `${key}=${val}`;
    return new RegExp(`^${key}=`, 'm').test(src) ? src.replace(new RegExp(`^${key}=.*$`, 'm'), line) : src + (src.endsWith('\n') || src === '' ? '' : '\n') + line + '\n';
  };
  env = setVar(env, 'AZTEC_NODE_URL', NODE_URL);
  env = setVar(env, 'AZNS_ADDRESS', addr);
  fs.writeFileSync('dapp/.env', env);
  console.log('\nwrote dapp/.env (merged):\n' + env);
  console.log('Run the dApp against testnet:  cd dapp && npm run dev');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
