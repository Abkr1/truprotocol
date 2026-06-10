// =============================================================================
//  pay_demo.ts - prove PRIVATE payments to a .tru name, end-to-end.
// =============================================================================
//  On a local network: deploy a token, mint to a payer, register a public name
//  pointing at a recipient, resolve it, send a PRIVATE transfer, and confirm the
//  recipient's PRIVATE balance moved. This is exactly what the dApp's
//  payPrivately() does. Run a local net (`aztec start --local-network`) first.
// =============================================================================
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { NO_FROM } from '@aztec/aztec.js/account';
import { Fr } from '@aztec/aztec.js/fields';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { TokenContract } from '@aztec/noir-contracts.js/Token';
import { AZNSContract } from '../azns/target/AZNS.js';
import { nameHash, labelLength, MODE, normaliseName } from './lib.js';
import fs from 'node:fs';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'http://localhost:8080';

async function main() {
  const zkp = JSON.parse(fs.readFileSync('zkp_data.json', 'utf-8'));
  const proverEnabled = !/localhost|127\.0\.0\.1/.test(NODE_URL);
  // ephemeral: in-memory PXE so stale data from earlier nets can't cause reorgs.
  const wallet = await EmbeddedWallet.create(NODE_URL, { ephemeral: true, pxe: { proverEnabled } });
  const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(0n) });
  await wallet.registerContract(fpc, SponsoredFPCContract.artifact);
  const fee = { paymentMethod: new SponsoredFeePaymentMethod(fpc.address) };

  const mk = async () => { const m = await wallet.createSchnorrAccount(Fr.random(), Fr.random()); await (await m.getDeployMethod()).send({ from: NO_FROM, fee }); };
  await mk(); await mk();
  const accts = await wallet.getAccounts();
  const payer = accts[0].item, recipient = accts[1].item;
  console.log('payer    :', payer.toString());
  console.log('recipient:', recipient.toString());

  const send = async (from: any, i: any) => { await i.send({ from, fee }); };
  const sim = async (from: any, i: any) => (await i.simulate({ from })).result;

  console.log('\ndeploying token + minting 1000 to payer ...');
  const { contract: token } = await TokenContract.deploy(wallet, payer, 'Test USD', 'TUSD', 18).send({ from: payer, fee });
  await send(payer, token.methods.mint_to_private(payer, 1000n));

  console.log('deploying AZNS + registering "trupay" -> recipient (public) ...');
  const { contract: azns } = await AZNSContract.deploy(wallet, zkp.vkHash).send({ from: payer, fee });
  const nh = await nameHash('trupay');
  const toFr = (xs: string[]) => xs.map((x) => Fr.fromString(x));
  await send(payer, azns.methods.register_first(nh, labelLength('trupay'), payer, 1, MODE.PUBLIC, toFr(zkp.vkAsFields), toFr(zkp.proofAsFields), toFr(zkp.publicInputs)));
  await send(payer, azns.methods.set_public_target(nh, recipient));

  console.log('\n--- balances before ---');
  console.log('payer    :', (await sim(payer, token.methods.balance_of_private(payer))).toString());
  console.log('recipient:', (await sim(recipient, token.methods.balance_of_private(recipient))).toString());

  // The payPrivately flow: resolve the name, then PRIVATE transfer to it.
  console.log(`\npaying ${normaliseName('trupay')} 250 privately ...`);
  const to = await sim(payer, azns.methods.resolve_public(nh));
  await send(payer, token.methods.transfer(to, 250n));

  console.log('\n--- balances after ---');
  const pAfter = BigInt((await sim(payer, token.methods.balance_of_private(payer))).toString());
  const rAfter = BigInt((await sim(recipient, token.methods.balance_of_private(recipient))).toString());
  console.log('payer    :', pAfter.toString());
  console.log('recipient:', rAfter.toString());

  if (pAfter === 750n && rAfter === 250n) {
    console.log('\n✅ PRIVATE PAYMENT OK: 250 moved to the name\'s target via a private transfer.');
    console.log('   On an explorer this shows only opaque note commitments — no sender, recipient, amount, or name.');
  } else {
    throw new Error(`unexpected balances: payer ${pAfter}, recipient ${rAfter}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
