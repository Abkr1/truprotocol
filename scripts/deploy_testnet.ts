// =============================================================================
//  deploy_testnet.ts - deploy AZNS to the Aztec public testnet.
// =============================================================================
//  Creates (and deploys) a fresh Schnorr account paid for by the canonical
//  sponsored FPC, deploys the fee-settlement token, then deploys AZNS wired to
//  it. Writes the node URL + AZNS address + payment-token address into dapp/.env
//  so the dApp connects to the live deployment.
//
//  Fee settlement ("test token now, real at deploy"):
//    PAY_TOKEN_ADDRESS  unset -> deploy a fresh 18-decimal TEST token (the
//                       operator is admin/minter) so the charge path is
//                       exercisable. Set it to an existing token (a real
//                       USD-pegged stablecoin) for the mainnet deploy; the
//                       operator then does NOT mint it.
//    TREASURY_ADDRESS   where fees go (default: the deployer account).
//    UNIT_PER_CENT      USD-cents -> token-base-units multiplier (default 1e16,
//                       i.e. 1 cent for an 18-decimal USD-pegged token, so the
//                       flat $21/yr costs 21 whole tokens).
//
//  Run (from repo root, inside WSL):
//    npm run deploy:testnet
//
//  Testnet node + version: https://rpc.testnet.aztec-labs.com (aztec 4.3.1).
// =============================================================================
import { AZNSContract } from '../azns/target/AZNS.js';
import { TokenContract } from '@aztec/noir-contracts.js/Token';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { setupDeployer } from './fees.js';
import fs from 'node:fs';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'https://rpc.testnet.aztec-labs.com';
const PAY_TOKEN_ADDRESS = process.env.PAY_TOKEN_ADDRESS ?? '';
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS ?? '';
const UNIT_PER_CENT = BigInt(process.env.UNIT_PER_CENT ?? (10n ** 16n).toString());

async function main() {
  console.log(`connecting to testnet: ${NODE_URL}`);
  // Stable deployer + automatic fee selection (native fee juice / claim / FPC).
  // setupDeployer also deploys the deployer account on-chain if needed.
  const { wallet, account, fee } = await setupDeployer(NODE_URL);

  // 1. Payment token: use the configured (real) token, else deploy a test one
  //    with the operator as admin/minter so registrations can be charged.
  let tokenAddr: AztecAddress;
  if (PAY_TOKEN_ADDRESS) {
    tokenAddr = AztecAddress.fromString(PAY_TOKEN_ADDRESS);
    console.log(`using configured payment token: ${tokenAddr}`);
  } else {
    console.log('deploying a test payment token (operator is admin/minter) ...');
    const { contract: token } = await TokenContract
      .deploy(wallet, account, 'tru Test USD', 'tUSD', 18)
      .send({ from: account, fee });
    tokenAddr = token.address;
    console.log(`test token deployed at: ${tokenAddr}`);
  }
  const treasury = TREASURY_ADDRESS ? AztecAddress.fromString(TREASURY_ADDRESS) : account;

  // 2. Deploy AZNS wired to the fee settlement config.
  console.log('deploying AZNS (permissionless registration, paid in token) ...');
  const { contract: azns } = await AZNSContract
    .deploy(wallet, tokenAddr, treasury, UNIT_PER_CENT)
    .send({ from: account, fee });
  const addr = azns.address.toString();
  console.log(`\nAZNS deployed on testnet at: ${addr}`);
  console.log(`  payment token: ${tokenAddr}`);
  console.log(`  treasury:      ${treasury}`);
  console.log(`  unit/cent:     ${UNIT_PER_CENT}`);

  // Wire the dApp to this deployment. MERGE into dapp/.env: replace only our
  // keys and keep everything else.
  let env = '';
  try { env = fs.readFileSync('dapp/.env', 'utf-8'); } catch { /* fresh file */ }
  const setVar = (src: string, key: string, val: string) => {
    const line = `${key}=${val}`;
    return new RegExp(`^${key}=`, 'm').test(src) ? src.replace(new RegExp(`^${key}=.*$`, 'm'), line) : src + (src.endsWith('\n') || src === '' ? '' : '\n') + line + '\n';
  };
  env = setVar(env, 'AZTEC_NODE_URL', NODE_URL);
  env = setVar(env, 'AZNS_ADDRESS', addr);
  env = setVar(env, 'PAY_TOKEN_ADDRESS', tokenAddr.toString());
  fs.writeFileSync('dapp/.env', env);
  console.log('\nwrote dapp/.env (merged):\n' + env);
  console.log('Run the dApp against testnet:  cd dapp && npm run dev');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
