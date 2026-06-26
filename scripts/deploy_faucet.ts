// =============================================================================
//  deploy_faucet.ts - deploy the open-mint test-token Faucet on v5 and approve
//  it as a minter of the registry's payment token, so the dApp browser flow is
//  fully self-serve (any fresh account can claim test tokens to register).
//
//  Run (repo root, WSL):  npm run deploy:faucet   (after npm run deploy:testnet)
//  Reads PAY_TOKEN_ADDRESS from dapp/.env; writes FAUCET_ADDRESS back to it.
// =============================================================================
import { FaucetContract } from '../faucet/target/Faucet.js';
import { TokenContract } from '@aztec/noir-contracts.js/Token';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { NO_FROM } from '@aztec/aztec.js/account';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { setupDeployer } from './fees.js';
import fs from 'node:fs';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'https://v5.testnet.rpc.aztec-labs.com';
const CLAIM_AMOUNT = 1000n * 10n ** 18n; // 1000 test tokens (covers many regs)

const big = (v: any): bigint => {
  let x = v;
  if (x && typeof x === 'object' && 'result' in x) x = (x as any).result;
  return BigInt((x && x.toString) ? x.toString() : x);
};
function envVar(key: string): string {
  try { const m = fs.readFileSync('dapp/.env', 'utf-8').match(new RegExp(`^${key}=(.*)$`, 'm')); return m ? m[1].trim() : ''; } catch { return ''; }
}
function setEnvVar(key: string, val: string) {
  let s = ''; try { s = fs.readFileSync('dapp/.env', 'utf-8'); } catch { /* fresh */ }
  const line = `${key}=${val}`;
  s = new RegExp(`^${key}=`, 'm').test(s) ? s.replace(new RegExp(`^${key}=.*$`, 'm'), line) : s + (s.endsWith('\n') || s === '' ? '' : '\n') + line + '\n';
  fs.writeFileSync('dapp/.env', s);
}

async function main() {
  console.log('faucet deploy against:', NODE_URL);
  const { wallet, account, node, fee } = await setupDeployer(NODE_URL);
  const tokenStr = process.env.PAY_TOKEN_ADDRESS || envVar('PAY_TOKEN_ADDRESS');
  if (!tokenStr) throw new Error('PAY_TOKEN_ADDRESS not set — run npm run deploy:testnet first.');
  const token = AztecAddress.fromString(tokenStr);
  console.log('payment token:', token.toString());

  // The operator PXE must know the token instance to call set_minter on it.
  try { const ti = await node.getContract(token); if (ti) await wallet.registerContract(ti, TokenContract.artifact); } catch { /* ok */ }
  const tok = await TokenContract.at(token, wallet);

  console.log('deploying Faucet ...');
  const { contract: faucet } = await FaucetContract.deploy(wallet, token).send({ from: account, fee });
  console.log('faucet:', faucet.address.toString());

  console.log('approving faucet as a token minter (set_minter) ...');
  await tok.methods.set_minter(faucet.address, true).send({ from: account, fee });

  // --- verify a FRESH, non-minter account can claim (proves it's open) ------
  console.log('verifying open claim from a fresh non-minter account ...');
  const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(0n) });
  await wallet.registerContract(fpc, SponsoredFPCContract.artifact);
  const sponsored = { paymentMethod: new SponsoredFeePaymentMethod(fpc.address) };
  const userMgr = await wallet.createSchnorrAccount(Fr.random(), Fr.random());
  await (await userMgr.getDeployMethod()).send({ from: NO_FROM, fee: sponsored });
  const user = (userMgr as any).address as AztecAddress;
  try { const fi = await node.getContract(faucet.address); if (fi) await wallet.registerContract(fi, FaucetContract.artifact); } catch { /* ok */ }
  const faucetC = await FaucetContract.at(faucet.address, wallet);
  await faucetC.methods.claim(CLAIM_AMOUNT).send({ from: user, fee: sponsored });
  const bal = big(await tok.methods.balance_of_private(user).simulate({ from: user }));
  console.log(`fresh user balance after claim: ${bal} (expect ${CLAIM_AMOUNT})`);

  setEnvVar('FAUCET_ADDRESS', faucet.address.toString());
  console.log('wrote FAUCET_ADDRESS to dapp/.env');

  const ok = bal === CLAIM_AMOUNT;
  console.log(`\nOPEN FAUCET E2E: ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
