// =============================================================================
//  demo.ts - end-to-end AZNS demo against a local network (or testnet).
// =============================================================================
//  Exercises all three resolution modes + lease renewal + option-1 multi-name,
//  using the v4.3.1 EmbeddedWallet + sponsored-FPC fee flow. Registration is
//  Sybil-gated, so it consumes the stand-in personhood proof in zkp_data.json
//  (generate with `npm run genproof`). Swap that for a real ZKPassport proof
//  for production.
//
//  Run:
//    aztec start --local-network            # in another terminal (port 8080)
//    npm run genproof                       # writes zkp_data.json
//    npm run demo                           # this script
//
//  Against testnet: set AZTEC_NODE_URL to the testnet node URL.
// =============================================================================
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { NO_FROM } from '@aztec/aztec.js/account';
import { Fr } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { getSponsoredFPCInstance } from './sponsored_fpc.js';
import { AZNSContract } from '../azns/target/AZNS.js';
import { nameHash, labelLength, priceCentsForLength, MODE, ONE_YEAR_SECS, normaliseName } from './lib.js';
import fs from 'node:fs';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'http://localhost:8080';
const now = () => BigInt(Math.floor(Date.now() / 1000));
const inOneYear = () => now() + ONE_YEAR_SECS;

// Normalise a simulation result into an AztecAddress. resolve_public/owner_of
// already return an AztecAddress object; my_resolution returns a raw Field
// (bigint/Fr/hex), which we wrap.
const toAddr = (v: any): AztecAddress => {
  if (v && v.constructor && v.constructor.name === 'AztecAddress') return v;
  if (v instanceof Fr) return AztecAddress.fromField(v);
  if (typeof v === 'bigint' || typeof v === 'number') return AztecAddress.fromField(new Fr(BigInt(v)));
  if (typeof v === 'string') return AztecAddress.fromField(new Fr(BigInt(v)));
  return AztecAddress.fromField(v);
};

function loadZkp() {
  if (!fs.existsSync('zkp_data.json')) return null;
  return JSON.parse(fs.readFileSync('zkp_data.json', 'utf-8'));
}

async function main() {
  const zkp = loadZkp();
  if (!zkp) {
    console.error('zkp_data.json not found - run `npm run genproof` first.');
    process.exit(1);
  }

  // --- 0. wallet + sponsored fee payment ---------------------------------
  const sponsoredFPC = await getSponsoredFPCInstance();
  const fee = { paymentMethod: new SponsoredFeePaymentMethod(sponsoredFPC.address) };
  const wallet = await EmbeddedWallet.create(NODE_URL);
  await wallet.registerContract(sponsoredFPC, SponsoredFPCContract.artifact);

  // Create three accounts (account contracts are deployed, fees sponsored).
  const mkAccount = async () => {
    const m = await wallet.createSchnorrAccount(Fr.random(), Fr.random());
    const dm = await m.getDeployMethod();
    await dm.send({ from: NO_FROM, fee });
  };
  await mkAccount();
  await mkAccount();
  await mkAccount();
  const accts = await wallet.getAccounts();
  const alice = accts[0].item;
  const bob = accts[1].item;
  const auditor = accts[2].item;
  console.log('alice  :', alice.toString());
  console.log('bob    :', bob.toString());
  console.log('auditor:', auditor.toString());

  // --- 1. deploy AZNS pinned to the stand-in personhood VK hash -----------
  const { contract: azns } = await AZNSContract.deploy(wallet, zkp.vkHash).send({ from: alice, fee });
  console.log('\nAZNS deployed at:', azns.address.toString());

  const send = async (from: AztecAddress, interaction: any) => {
    await interaction.send({ from, fee });
  };
  const sim = async (from: AztecAddress, interaction: any) =>
    (await interaction.simulate({ from })).result;

  // Register helper: first call uses register_first (carries the proof, marks
  // the owner a verified human); later calls use register (no proof needed).
  let aliceVerified = false;
  const doRegister = async (raw: string, owner: AztecAddress, mode: number, years = 1) => {
    const nh = await nameHash(raw);
    const len = labelLength(raw);
    console.log(`   registering "${normaliseName(raw)}" (len ${len}, $${priceCentsForLength(len) / 100}/yr)`);
    if (!aliceVerified) {
      await send(
        alice,
        azns.methods.register_first(nh, len, owner, years, mode, zkp.vkAsFields, zkp.proofAsFields, zkp.publicInputs),
      );
      aliceVerified = true;
      console.log('   (verified once via stand-in personhood proof; later names need no proof)');
    } else {
      await send(alice, azns.methods.register(nh, len, owner, years, mode));
    }
    return nh;
  };
  const epochOf = async (nh: any) => sim(alice, azns.methods.current_epoch(nh));

  // --- 2. MODE_PUBLIC ----------------------------------------------------
  const trulib = await doRegister('trulib', alice, MODE.PUBLIC);
  await send(alice, azns.methods.set_public_target(trulib, bob));
  const pub = await sim(alice, azns.methods.resolve_public(trulib));
  console.log(`\n[PUBLIC]  ${normaliseName('trulib')} -> ${toAddr(pub).toString()}  (anyone can read; expect bob)`);

  // --- 3. MODE_PRIVATE ---------------------------------------------------
  const me = await doRegister('abubakar', alice, MODE.PRIVATE);
  const meEpoch = await epochOf(me);
  await send(alice, azns.methods.grant(me, alice, bob, inOneYear(), meEpoch));
  const mine = await sim(alice, azns.methods.my_resolution(me, meEpoch));
  console.log(`\n[PRIVATE] ${normaliseName('abubakar')} -> ${toAddr(mine).toString()}  (only alice; expect bob)`);
  const leak = await sim(alice, azns.methods.resolve_public(me));
  console.log('          public read attempt:', toAddr(leak).toString(), '(expect 0x0)');

  // --- 4. MODE_SELECTIVE -------------------------------------------------
  const corp = await doRegister('trulib-corp', alice, MODE.SELECTIVE);
  const corpEpoch = await epochOf(corp);
  await send(alice, azns.methods.grant(corp, auditor, alice, inOneYear(), corpEpoch)); // auditor -> treasury (alice)
  await send(alice, azns.methods.grant(corp, bob, bob, inOneYear(), corpEpoch)); // bob -> routing (bob)
  const auditorView = await sim(auditor, azns.methods.my_resolution(corp, corpEpoch));
  const bobView = await sim(bob, azns.methods.my_resolution(corp, corpEpoch));
  console.log(`\n[SELECTIVE] ${normaliseName('trulib-corp')}`);
  console.log('  auditor sees:', toAddr(auditorView).toString(), '(treasury / alice)');
  console.log('  bob sees    :', toAddr(bobView).toString(), '(routing / bob)');
  console.log('  -> same name, different resolution per viewer. This is the differentiator.');

  // --- 5. LEASE: renew trulib +2yr, read status --------------------------
  const trulibLen = labelLength('trulib');
  await send(alice, azns.methods.renew(trulib, trulibLen, 2));
  const status = await sim(alice, azns.methods.lease_status(trulib));
  console.log(`\n[LEASE]   renewed ${normaliseName('trulib')} +2yr; lease_status -> ${status} (expect 1 active)`);

  // --- 6. OPTION 1 recap -------------------------------------------------
  const verified = await sim(alice, azns.methods.is_verified(alice));
  console.log(`\n[VERIFY]  alice is_verified -> ${verified} (proved once, bought 3 names)`);

  console.log('\nAll three modes + lease renewal + option-1 multi-name exercised on-chain.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
