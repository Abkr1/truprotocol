// =============================================================================
//  deploy_beacon.ts - deploy the payment-discovery Beacon (key registry +
//  encrypted announce; see beacon/src/main.nr) and write BEACON_ADDRESS to
//  dapp/.env so the dApp announces payments and scans for incoming ones.
//
//  Run (repo root, WSL):  npm run deploy:beacon
// =============================================================================
import { BeaconContract } from '../beacon/target/Beacon.js';
import { setupDeployer } from './fees.js';
import fs from 'node:fs';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'https://v5.testnet.rpc.aztec-labs.com';
const CHECKPOINTED = { waitForStatus: 'checkpointed' as any };

function setEnvVar(key: string, val: string) {
  let s = ''; try { s = fs.readFileSync('dapp/.env', 'utf-8'); } catch { /* fresh */ }
  const line = `${key}=${val}`;
  s = new RegExp(`^${key}=`, 'm').test(s) ? s.replace(new RegExp(`^${key}=.*$`, 'm'), line) : s + (s.endsWith('\n') || s === '' ? '' : '\n') + line + '\n';
  fs.writeFileSync('dapp/.env', s);
}

async function main() {
  console.log('beacon deploy against:', NODE_URL);
  const { wallet, account, fee } = await setupDeployer(NODE_URL);
  console.log('deploying Beacon (key registry + announce), waiting canonical ...');
  const { contract: beacon } = await BeaconContract.deploy(wallet).send({ from: account, fee, wait: CHECKPOINTED });
  console.log('beacon:', beacon.address.toString());
  setEnvVar('BEACON_ADDRESS', beacon.address.toString());
  console.log('wrote BEACON_ADDRESS to dapp/.env');
}

main().catch((e) => { console.error(e); process.exit(1); });
