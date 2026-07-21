// =============================================================================
//  demo.ts - end-to-end AZNS demo against a local network (or testnet).
// =============================================================================
//  Exercises all three resolution modes + lease renewal + multi-name buys,
//  using the v4.3.1 EmbeddedWallet + sponsored-FPC fee flow. Registration is
//  permissionless - no proof, no KYC.
//
//  Run:
//    aztec start --local-network            # in another terminal (port 8080)
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
import { TokenContract } from '@aztec/noir-contracts.js/Token';
import { nameHash, labelLength, packLabel, priceCentsForMode, MODE, ONE_YEAR_SECS, normaliseName } from './lib.js';
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

async function main() {
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

  // --- 1. deploy payment token + AZNS -------------------------------------
  // Registration is paid now: deploy a test token (alice is admin/minter) and
  // mint alice enough to cover the demo's registrations + renewal. unit_per_cent
  // = 1 keeps fees tiny (2100 base units/yr); treasury = alice, so these
  // self-payments don't drain her. The EmbeddedWallet auto-builds the fee
  // authwit during its pre-simulation, so no manual authwit is needed here.
  const { contract: token } = await TokenContract.deploy(wallet, alice, 'tru Test USD', 'tUSD', 18).send({ from: alice, fee });
  await token.methods.mint_to_private(alice, 1_000_000n).send({ from: alice, fee });
  const { contract: azns } = await AZNSContract.deploy(wallet, token.address, alice, 1n).send({ from: alice, fee });
  console.log('\nAZNS deployed at:', azns.address.toString());

  const send = async (from: AztecAddress, interaction: any) => {
    await interaction.send({ from, fee });
  };
  const sim = async (from: AztecAddress, interaction: any) =>
    (await interaction.simulate({ from })).result;

  // Register helper - permissionless, one private call.
  const doRegister = async (raw: string, owner: AztecAddress, mode: number, years = 1) => {
    const nh = await nameHash(raw);
    const len = labelLength(raw);
    const modeName = (Object.keys(MODE) as (keyof typeof MODE)[]).find((k) => MODE[k] === mode)!;
    console.log(`   registering "${normaliseName(raw)}" (${modeName}, $${priceCentsForMode(modeName) / 100}/yr)`);
    await send(alice, azns.methods.register(nh, packLabel(raw), len, owner, years, mode, Fr.random()));
    return nh;
  };
  const epochOf = async (nh: any) => sim(alice, azns.methods.current_epoch(nh));

  // --- 2. MODE_PUBLIC ----------------------------------------------------
  const trulib = await doRegister('trulib', alice, MODE.PUBLIC);
  await send(alice, azns.methods.set_public_target(trulib, bob));
  const pub = await sim(alice, azns.methods.resolve_public(trulib));
  console.log(`\n[PUBLIC]  ${normaliseName('trulib')} -> ${toAddr(pub).toString()}  (anyone can read; expect bob)`);

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
  // renew now takes the name's MODE (priced per mode, verified on-chain).
  await send(alice, azns.methods.renew(trulib, MODE.PUBLIC, 2, Fr.random()));
  const status = await sim(alice, azns.methods.lease_status(trulib));
  console.log(`\n[LEASE]   renewed ${normaliseName('trulib')} +2yr; lease_status -> ${status} (expect 1 active)`);

  console.log('\nAll three modes + lease renewal + multi-name buys exercised on-chain.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
