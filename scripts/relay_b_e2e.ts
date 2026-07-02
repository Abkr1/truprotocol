// =============================================================================
//  relay_b_e2e.ts - OPTION B: off-chain encrypted-hint relay.
// =============================================================================
//  Proves the recipient can discover an incoming private payment WITHOUT knowing
//  the sender in advance, via an off-chain relay (Aztec's idiomatic OFFCHAIN
//  delivery). Flow:
//    S pays R (private transfer) THEN posts a hint {to: R, sender: S} to a relay.
//    R (separate PXE, never told the sender) POLLS the relay for its address,
//    learns the payer, registerSender(payer) -> the payment appears.
//
//  The relay here is a real in-process HTTP server (in-memory store) to show the
//  genuine off-chain transport. NOTE: in production the hint is ENCRYPTED to R's
//  public key so the relay learns nothing (payer/amount stay private); here we
//  carry the payer address in the clear to keep the test focused on discovery.
//
//  Run (repo root, WSL):  bash run_relay_b.sh
// =============================================================================
import http from 'node:http';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { TokenContract } from '@aztec/noir-contracts.js/Token';
import { Fr } from '@aztec/aztec.js/fields';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { setupDeployer, tolerantNode } from './fees.js';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'https://v5.testnet.rpc.aztec-labs.com';
const MINT = 1000n, SEND = 500n;
const CHECKPOINTED = { waitForStatus: 'checkpointed' as any };
const TRANSIENT = /dropped|P2P|timeout|propagat|reorg|fetch|Block hash|not ready|Failed to get a note/i;

const big = (v: any): bigint => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' || typeof v === 'string') return BigInt(v);
  if (v && typeof v === 'object') { if ('result' in v) return big(v.result); if ('value' in v) return big(v.value); const s = v.toString?.() ?? ''; if (s && s !== '[object Object]') return BigInt(s); }
  return BigInt(v);
};
const sendWait = async (label: string, make: () => any, opts: any, tries = 4): Promise<void> => {
  for (let i = 1; i <= tries; i++) {
    try { const ix = await make(); await ix.send(opts); return; }
    catch (e: any) { const m = String(e?.message ?? e).split('\n')[0];
      if (/Existing nullifier|already.*(deploy|exist)/i.test(m)) { console.log(`  ${label}: already landed`); return; }
      if (i < tries && TRANSIENT.test(m)) { console.log(`  ${label}: retry ${i} (${m.slice(0, 50)})`); await new Promise(r => setTimeout(r, 4000)); continue; }
      throw e; }
  }
};

// ---- the relay: a tiny in-memory off-chain hint bus (POST /post, GET /poll) ---
function startRelay(): Promise<{ url: string; close: () => void }> {
  const inbox = new Map<string, string[]>();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    if (req.method === 'POST' && u.pathname === '/post') {
      let body = ''; req.on('data', c => body += c); req.on('end', () => {
        const { to, hint } = JSON.parse(body); inbox.set(to, [...(inbox.get(to) ?? []), hint]);
        res.end('ok');
      });
    } else if (req.method === 'GET' && u.pathname === '/poll') {
      const to = u.searchParams.get('to')!; res.end(JSON.stringify(inbox.get(to) ?? []));
    } else { res.statusCode = 404; res.end(); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as any).port;
    resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
  }));
}

async function main() {
  console.log(`OPTION B (off-chain relay) against: ${NODE_URL}\n`);
  const relay = await startRelay();
  console.log('relay up at', relay.url);

  const { wallet: S, account: sender, fee } = await setupDeployer(NODE_URL);
  console.log('sender   (S):', sender.toString());

  console.log('\ndeploying token, waiting canonical ...');
  let token: any;
  for (let i = 1; i <= 4; i++) { try { ({ contract: token } = await TokenContract.deploy(S, sender, 'tru Relay B', 'tRB', 18).send({ from: sender, fee, wait: CHECKPOINTED })); break; } catch (e: any) { if (i < 4 && TRANSIENT.test(String(e?.message ?? e))) { await new Promise(r => setTimeout(r, 4000)); continue; } throw e; } }

  // R is NEVER deployed on-chain: receiving notes + reading balances need no
  // account contract (only tx senders do) - so R needs no fees at all.
  const R = await EmbeddedWallet.create(tolerantNode(NODE_URL), { pxe: { proverEnabled: true }, ephemeral: true });
  await R.createSchnorrAccount(Fr.random(), Fr.random());
  const recipient = (await R.getAccounts())[0].item;
  console.log('recipient(R):', recipient.toString());
  const node = tolerantNode(NODE_URL);
  await R.registerContract((await node.getContract(token.address))!, TokenContract.artifact);

  console.log(`\nS mints ${MINT}, transfers ${SEND} to R ...`);
  await sendWait('mint', () => token.methods.mint_to_private(sender, MINT), { from: sender, fee, wait: CHECKPOINTED });
  await sendWait('transfer', () => token.methods.transfer(recipient, SEND), { from: sender, fee, wait: CHECKPOINTED });

  // S posts an off-chain hint to the relay (prod: encrypt `hint` to R's pubkey).
  await fetch(`${relay.url}/post`, { method: 'POST', body: JSON.stringify({ to: recipient.toString(), hint: sender.toString() }) });
  console.log('S posted an off-chain hint to the relay.');

  const tokenAtR = await TokenContract.at(token.address, R);
  const rBal = async () => big(await tokenAtR.methods.balance_of_private(recipient).simulate({ from: recipient }));
  const before = await rBal();
  console.log(`\nR balance BEFORE polling relay: ${before}   (expect 0)`);

  // R knows NOTHING about the sender; it learns it purely from the relay.
  const hints: string[] = await (await fetch(`${relay.url}/poll?to=${recipient.toString()}`)).json();
  console.log(`R polled the relay -> ${hints.length} hint(s):`, hints.map(h => h.slice(0, 12) + '…'));
  for (const h of hints) await R.registerSender(AztecAddress.fromStringUnsafe(h));
  let after = await rBal();
  if (after !== SEND) { await new Promise(r => setTimeout(r, 6000)); after = await rBal(); }
  console.log(`R balance AFTER  relay+registerSender: ${after}   (expect ${SEND})`);

  relay.close();
  const pass = before === 0n && after === SEND && hints.length > 0;
  console.log('\n--- RESULT (Option B) ---');
  console.log(`  learned sender via relay only : ${hints.length > 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  payment discovered            : ${after === SEND ? 'PASS' : 'FAIL'} (${after})`);
  console.log(`  OPTION B END-TO-END           : ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
