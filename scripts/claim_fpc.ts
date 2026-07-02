// =============================================================================
//  claim_fpc.ts - consume a faucet fee-juice claim FOR the shared sponsored
//  FPC (refuels sponsored fees for dApp browser accounts after a chain reset).
// =============================================================================
//  Faucet flow: paste the FPC ADDRESS into the faucet (it bridges fee juice on
//  L1 to that recipient), then consume the claim here — FeeJuice.claim() is a
//  public function callable by ANYONE holding the claim secret; the recipient
//  of the funds is fixed by the L1 message, so the deployer can finalize it on
//  the FPC's behalf, paying the small tx fee natively.
//
//  Usage (env): CLAIM_AMOUNT=... CLAIM_SECRET=0x... CLAIM_INDEX=... \
//               npm run claim:fpc
// =============================================================================
import { FeeJuiceContract } from '@aztec/noir-contracts.js/FeeJuice';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { ProtocolContractAddress } from '@aztec/protocol-contracts';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { Fr } from '@aztec/aztec.js/fields';
import { getFeeJuiceBalance } from '@aztec/aztec.js/utils';
import { setupDeployer } from './fees.js';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'https://v5.testnet.rpc.aztec-labs.com';

async function main() {
  const a = process.env.CLAIM_AMOUNT, s = process.env.CLAIM_SECRET, i = process.env.CLAIM_INDEX;
  if (!a || !s || !i) throw new Error('set CLAIM_AMOUNT, CLAIM_SECRET and CLAIM_INDEX (from the faucet)');

  const { wallet, account, node, fee } = await setupDeployer(NODE_URL);
  const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(0n) });
  const fjAddr = ProtocolContractAddress.FeeJuice;
  try { const inst = await node.getContract(fjAddr); if (inst) await wallet.registerContract(inst, FeeJuiceContract.artifact); } catch { /* may be preloaded */ }
  const feeJuice = await FeeJuiceContract.at(fjAddr, wallet);

  // The L1->L2 message commits to ONE recipient (whatever address was pasted
  // into the faucet). Try the FPC first, then the deployer: the wrong one
  // fails at local simulation (free); only the right one goes on-chain.
  // Retry rounds cover the faucet's ~3-4 min L1->L2 bridge delay.
  const candidates = [
    { name: 'sponsored FPC', addr: fpc.address },
    { name: 'deployer', addr: account },
  ];
  const balances = async () => {
    for (const c of candidates) console.log(`  ${c.name}: ${await getFeeJuiceBalance(c.addr, node as any)}`);
  };
  console.log('fee-juice balances before:'); await balances();

  let winner: { name: string; addr: any } | null = null;
  outer: for (let round = 1; round <= 5 && !winner; round++) {
    for (const c of candidates) {
      try {
        console.log(`round ${round}: claiming ${a} for ${c.name} ...`);
        await feeJuice.methods.claim(c.addr, BigInt(a), Fr.fromString(s), BigInt(i))
          .send({ from: account, fee, wait: { waitForStatus: 'checkpointed' as any } });
        winner = c; break outer;
      } catch (e: any) {
        console.log(`  not ${c.name}: ${String(e?.message ?? e).split('\n')[0].slice(0, 110)}`);
      }
    }
    if (round < 5) { console.log('  (message may still be bridging - waiting 60s)'); await new Promise(r => setTimeout(r, 60_000)); }
  }
  if (!winner) throw new Error('claim not consumable for either recipient - is the drip still bridging, or already consumed?');

  console.log(`\nclaim consumed for the ${winner.name}. balances after:`); await balances();
  console.log(winner.name === 'sponsored FPC'
    ? '\nFPC REFUELLED - sponsored fees (dApp browser accounts + FEE_MODE=sponsored deploys) work again.'
    : '\nDEPLOYER REFUELLED - native-fee deploys can proceed.');
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
