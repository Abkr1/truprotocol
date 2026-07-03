// =============================================================================
//  aztec.ts - browser service layer for the truProtocol dApp (consumer-friendly).
// =============================================================================
//  Two phases so the UI feels like ENS:
//   - connect(): light read-only setup (wallet + PXE + contract + an in-PXE
//     account that is NOT yet deployed). Enough to SEARCH names instantly.
//   - ensureWritable(): deploys that account (sponsored) the first time the
//     user actually registers. Real proving (testnet) happens only on writes.
// =============================================================================
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { NO_FROM } from '@aztec/aztec.js/account';
import { Fr } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { getFeeJuiceBalance } from '@aztec/aztec.js/utils';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { openTmpStore } from '@aztec/kv-store/sqlite-opfs';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { AZNSContract } from './contracts/AZNS';
import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';
import { azguardState, azSendTx, azUtility, azRegisterSender, azRegisterContract } from './azguard';
import {
  nameHash, labelLength, normaliseName, packLabel, unpackLabel,
  MODE, MIN_LABEL, MAX_LABEL, ONE_YEAR_SECS, nowSecs, type ModeName,
} from './lib';

const NODE_URL = (process.env.AZTEC_NODE_URL && process.env.AZTEC_NODE_URL.length > 0)
  ? process.env.AZTEC_NODE_URL
  : 'http://localhost:8080';
const IS_LOCAL = /localhost|127\.0\.0\.1/.test(NODE_URL);

// Chain-dependent state is scoped to the configured registry: a redeploy (or a
// testnet chain RESET) must never carry an "account already deployed" flag or
// beacon bookkeeping over to a chain where it isn't true.
const REGISTRY_TAG = (process.env.AZNS_ADDRESS || 'local').toLowerCase().slice(0, 14);
const LS = {
  secret: 'azns.secret',
  salt: 'azns.salt',
  accountDeployed: `azns.accountDeployed.${REGISTRY_TAG}`,
  aznsAddress: 'azns.aznsAddress',
  account: 'azns.account',
};

type Manager = Awaited<ReturnType<EmbeddedWallet['createSchnorrAccount']>>;

type Conn = {
  wallet: EmbeddedWallet;
  account: AztecAddress;
  manager: Manager | null;
  fee: any;          // {} = native fee juice; else { paymentMethod: SponsoredFeePaymentMethod }
  feeLabel: string;
  funded: boolean;   // account already holds native fee juice (=> already deployed)
  azns: AZNSContract;
  node: any;         // aztec node client, for registering external contract instances
};

export type SearchResult = {
  label: string;
  name: string;        // normalised "x.tru"
  len: number;
  tooShort: boolean;
  tooLong: boolean;
  available: boolean;
  status: number;      // 0 available, 1 active, 2 grace
  mine: boolean;
  // price depends on the privacy mode picked at registration (see lib PRICE_CENTS)
};

let conn: Conn | null = null;
let connecting: Promise<Conn> | null = null;

const lsGet = (k: string) => globalThis.localStorage?.getItem(k) ?? null;
const lsSet = (k: string, v: string) => globalThis.localStorage?.setItem(k, v);

function toAddr(v: any): AztecAddress {
  if (typeof v === 'bigint' || typeof v === 'number') return AztecAddress.fromFieldUnsafe(new Fr(BigInt(v)));
  const s = (v && typeof v.toString === 'function') ? v.toString() : String(v);
  return AztecAddress.fromFieldUnsafe(Fr.fromString(s));
}

// The testnet runs a rolling `dev` node that dropped the debug-only RPC method
// `aztec_registerContractFunctionSignatures`. The PXE calls it during PXE.create
// and registerContract, so an un-patched connect() aborts with -32601 ("Method
// not found") and the wallet never connects. Wrap the node client so that ONE
// debug method is a harmless no-op; every other call passes straight through.
function tolerantNode(url: string): any {
  const n: any = createAztecNodeClient(url);
  return new Proxy(n, {
    get(t, p, r) { return p === 'registerContractFunctionSignatures' ? async () => {} : Reflect.get(t, p, r); },
  });
}

/** Light read-only connect: ready to search, no on-chain account deploy yet. */
export async function connect(log: (m: string) => void = () => {}): Promise<Conn> {
  if (conn) return conn;
  if (connecting) return connecting;
  connecting = (async () => {
    const proverEnabled = !IS_LOCAL; // real proofs on testnet (writes only)
    // The nightly SDK stores both the PXE and the wallet DB in SQLite-OPFS, and
    // its SAH pool takes an EXCLUSIVE lock on one shared default directory — two
    // OPFS stores in a tab deadlock ("another open Access Handle"), so
    // EmbeddedWallet.create throws. Give the wallet DB an in-memory store: only
    // the PXE then uses OPFS (one pool, no contention). The wallet DB only
    // caches accounts + senders, which we re-derive from the localStorage
    // secret (createSchnorrAccount) and the beacon scan on every load anyway.
    const walletStore = await openTmpStore(true);
    const wallet = await EmbeddedWallet.create(tolerantNode(NODE_URL), { pxe: { proverEnabled }, walletDb: { store: walletStore } });

    const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(0n) });
    await wallet.registerContract(fpc, SponsoredFPCContract.artifact);
    const node = tolerantNode(NODE_URL);

    // Self-custody wallet: each browser holds its OWN account key in localStorage.
    // No shared/"house" secret is ever embedded in the app — that would be a
    // funded key every visitor could read straight out of the bundle. Fees come
    // from this account's native fee juice if it has any, else from the sponsored
    // FPC (which the operator funds); the user supplies the registration token.
    let secret = lsGet(LS.secret); let salt = lsGet(LS.salt);
    if (!secret || !salt) {
      secret = Fr.random().toString(); salt = Fr.random().toString();
      lsSet(LS.secret, secret); lsSet(LS.salt, salt);
    }

    let manager: Manager | null = null;
    try { manager = await wallet.createSchnorrAccount(Fr.fromString(secret), Fr.fromString(salt)); }
    catch { manager = null; } // already registered in this PXE

    // Select THIS account specifically (getAccounts()[0] could be a stale one
    // left in the PXE from an earlier session / different keys).
    let account: AztecAddress;
    if (manager) { account = (manager as any).address; lsSet(LS.account, account.toString()); }
    else {
      const accts = await wallet.getAccounts();
      const want = lsGet(LS.account);
      account = (want ? accts.find((a) => a.item.toString() === want)?.item : undefined) ?? accts[0].item;
    }

    // Pay like the deployer: native fee juice when this account is funded, else
    // fall back to the shared sponsored FPC. A funded account is already on-chain.
    let funded = false;
    try { funded = (await getFeeJuiceBalance(account, node as any)) > 0n; } catch { funded = false; }
    const fee = funded ? {} : { paymentMethod: new SponsoredFeePaymentMethod(fpc.address) };
    const feeLabel = funded ? 'native fee juice' : 'sponsored FPC';

    // A configured deployment (dapp/.env) wins over any locally-deployed address
    // left in localStorage from earlier dev sessions.
    const envAddr = process.env.AZNS_ADDRESS && process.env.AZNS_ADDRESS.length > 0 ? process.env.AZNS_ADDRESS : '';
    const known = envAddr || lsGet(LS.aznsAddress) || '';
    if (!known) throw new Error('No name registry configured (set AZNS_ADDRESS in dapp/.env).');
    // Register the already-deployed AZNS instance with this PXE so we can both
    // read AND send to it (a fresh PXE doesn't know contracts it didn't deploy).
    try {
      const inst = await node.getContract(AztecAddress.fromStringUnsafe(known));
      if (inst) await wallet.registerContract(inst, AZNSContract.artifact);
    } catch { /* may already be registered, or sim-only works */ }
    const azns = await AZNSContract.at(AztecAddress.fromStringUnsafe(known), wallet);

    // Register the payment-token INSTANCE too (a fresh PXE only knows contracts
    // it deployed), so private balance reads AND the fee-charge simulation can
    // find it. Done here in the serial connect phase, before any polling starts.
    // Resolve the token from env, else the registry's payment_token() view.
    try {
      const payTok = (process.env.PAY_TOKEN_ADDRESS && process.env.PAY_TOKEN_ADDRESS.length > 0)
        ? process.env.PAY_TOKEN_ADDRESS
        : toAddr((await azns.methods.payment_token().simulate({ from: account })).result).toString();
      if (payTok && !toAddr(payTok).isZero()) {
        const { TokenContract } = await import('@aztec/noir-contracts.js/Token');
        const tinst = await node.getContract(AztecAddress.fromStringUnsafe(payTok));
        if (tinst) await wallet.registerContract(tinst, TokenContract.artifact);
      }
    } catch { /* token not configured, already registered, or older registry */ }

    conn = { wallet, account, manager, fee, feeLabel, funded, azns, node };
    return conn;
  })();
  try { return await connecting; } finally { connecting = null; }
}

// ---- External wallet (Azguard) mode layer --------------------------------------
// When an Azguard session is active, PRIVATE STATE + WRITES route through the
// wallet (it holds the keys, proves, and pays fees); PUBLIC reads keep using our
// own read-PXE in both modes (fast, and independent of the wallet's protocol
// version). Everything below branches through these helpers.
function azMode(): { address: string } | null {
  const s = azguardState();
  return s ? { address: s.address } : null;
}
export function walletMode(): 'embedded' | 'azguard' { return azMode() ? 'azguard' : 'embedded'; }
/** The account the user is acting as: the Azguard account when connected,
 *  else this browser's embedded account. */
function activeAccount(): AztecAddress {
  const a = azMode();
  return a ? AztecAddress.fromStringUnsafe(a.address) : conn!.account;
}
// Register this registry's contracts in the WALLET's PXE once per session so
// its simulations/txs can resolve them. Best-effort: on a wallet build that
// doesn't support this network yet, errors surface on the actual operation.
// Memoized by PROMISE (not a done-flag) so a concurrent caller - the balance
// watcher racing a user action - awaits the in-flight registration instead of
// proceeding before the wallet knows the contracts.
let azContractsFor = '';
let azContractsJob: Promise<void> | null = null;
function ensureAzContracts(): Promise<void> {
  const a = azMode();
  if (!a) return Promise.resolve();
  if (azContractsFor === a.address && azContractsJob) return azContractsJob;
  azContractsFor = a.address;
  azContractsJob = (async () => {
    const addrs = [
      conn?.azns.address.toString(),
      await paymentToken().catch(() => ''),
      BEACON_ADDRESS,
      (process.env.FAUCET_ADDRESS && process.env.FAUCET_ADDRESS.length > 0) ? process.env.FAUCET_ADDRESS : '',
    ].filter((x): x is string => !!x);
    for (const addr of addrs) {
      try { await azRegisterContract(addr); }
      catch (e) { console.warn('azguard register_contract failed (wallet may not support this network yet):', addr, e); }
    }
  })();
  return azContractsJob;
}

// v5's PXE runs ONE job at a time ("concurrent execution is not supported"), so
// serialize every PXE read/write through this chain. Without it the dApp's
// overlapping operations (search + the balance watcher + connect) collide and
// some fail to see freshly-registered contract instances.
let pxeChain: Promise<unknown> = Promise.resolve();
function withPxe<T>(fn: () => Promise<T>): Promise<T> {
  const result = pxeChain.then(fn, fn);
  pxeChain = result.then(() => {}, () => {});
  return result;
}
const sim = (interaction: any) => withPxe(async () => (await interaction.simulate({ from: conn!.account })).result);
// Track in-flight transactions so background polling never competes with the prover.
let txInFlight = 0;
const send = (interaction: any) => withPxe(async () => {
  txInFlight++;
  try { await interaction.send({ from: conn!.account, fee: conn!.fee }); }
  finally { txInFlight--; }
});

// The v5 testnet/PXE has transient hiccups — an unsynced note ("Failed to get a
// note"), a dropped fetch, a brief network blip — that a retry clears (the next
// attempt re-syncs the PXE first). `make` must build a FRESH interaction each
// try. An already-applied write (name taken / nullifier exists) counts as done.
async function sendRetry(make: () => any, tries = 3): Promise<void> {
  for (let i = 1; i <= tries; i++) {
    try { await send(make()); return; }
    catch (e: any) {
      const m = String(e?.message ?? e);
      if (/name registered or in grace|Existing nullifier/i.test(m)) return; // already landed
      const transient = /Failed to get a note|Failed to fetch|fetch failed|dropped|timeout|reorg|ECONN|network|not ready|Block hash/i.test(m);
      if (i < tries && transient) { await new Promise((r) => setTimeout(r, 4000)); continue; }
      throw e;
    }
  }
}

// ---- registration / renewal fees ---------------------------------------------
// register()/renew() pull the per-mode fee from the buyer's token balance via
// Token.transfer_in_private. The EmbeddedWallet builds the required authwit
// AUTOMATICALLY when it pre-simulates the tx (it captures the call-authorization
// request and signs it on the account's behalf), so there is no manual authwit
// to construct here. The only thing that can surprise a user is an insufficient
// balance — check that up front and raise a friendly error rather than letting
// the on-chain charge revert opaquely.
async function feeAmount(modeVal: number, years: number): Promise<bigint> {
  return BigInt((await sim(conn!.azns.methods.fee_amount(modeVal, years))).toString());
}
let cachedTreasury = '';
async function treasuryAddr(): Promise<string> {
  if (cachedTreasury) return cachedTreasury;
  return (cachedTreasury = toAddr(await sim(conn!.azns.methods.treasury())).toString());
}
/** The fee-pull authwit action for Azguard txs: authorize AZNS to move the
 *  per-mode fee from the connected account to the treasury (the wallet signs
 *  it). Mirrors what the EmbeddedWallet auto-creates during pre-simulation. */
async function azFeeAuthwitActions(modeVal: number, years: number, payer: string): Promise<any[]> {
  const fee = await feeAmount(modeVal, years);
  if (fee === 0n) return []; // free config - nothing to authorize
  return [{
    kind: 'add_private_authwit',
    content: {
      kind: 'call',
      caller: conn!.azns.address.toString(),
      contract: await paymentToken(),
      method: 'transfer_in_private',
      args: [payer, await treasuryAddr(), fee.toString(), 0],
    },
  }];
}
async function ensureFeeCovered(modeVal: number, years: number): Promise<void> {
  const fee = await feeAmount(modeVal, years);
  if (fee === 0n) return; // free config (e.g. unit_per_cent = 0 in a test deploy)
  const bal = (await tokenBalance()) ?? 0n;
  if (bal < fee) {
    throw new Error(
      'Not enough of the registration token to cover the fee. Click "Get test tokens" first, or fund this account with the registry\'s payment token.',
    );
  }
}

/** Deploy the user's account on first write (sponsored). */
async function ensureWritable(onStep: (m: string) => void = () => {}): Promise<void> {
  if (azMode()) { await ensureAzContracts(); return; } // wallet accounts are managed by the wallet
  const c = conn!;
  if (c.funded) { lsSet(LS.accountDeployed, '1'); return; } // funded => already on-chain
  if (lsGet(LS.accountDeployed)) return;
  onStep('Setting up your wallet (one-time)…');
  if (!c.manager) c.manager = await c.wallet.createSchnorrAccount(Fr.fromString(lsGet(LS.secret)!), Fr.fromString(lsGet(LS.salt)!));
  // Wait for the account deploy to be CHECKPOINTED (canonical), not just the
  // default PROPOSED: the PXE only reliably syncs notes from canonical blocks,
  // and the account's signing-key note (a SinglePrivateImmutable) must be synced
  // before its FIRST entrypoint tx — else that tx fails with "Failed to get a
  // note" on a brand-new account (the symptom users hit on the very first claim).
  onStep('Finalizing your wallet (one-time, ~1 min)…');
  try {
    await (await c.manager.getDeployMethod()).send({ from: NO_FROM, fee: c.fee, wait: { waitForStatus: 'checkpointed' as any } });
  } catch (e: any) {
    if (!/already|deployed|exist/i.test(e?.message ?? '')) throw e;
  }
  lsSet(LS.accountDeployed, '1');
  // Now that the account exists on-chain, publish its discovery key in the
  // background so incoming payments can find us (never blocks the caller; the
  // payment watcher retries it if this attempt loses to a testnet hiccup).
  ensureBeaconKey().catch(() => { /* retried from the watcher */ });
}

/** Search a label for availability. Read-only, fast. */
export async function search(raw: string): Promise<SearchResult> {
  await connect();
  const label = raw.normalize('NFC').trim().toLowerCase().replace(/\.tru$/, '');
  const name = normaliseName(raw);
  const len = labelLength(raw);
  const base = { label, name, len, available: false, status: -1, mine: false };
  if (len < MIN_LABEL) return { ...base, tooShort: true, tooLong: false };
  if (len > MAX_LABEL) return { ...base, tooShort: false, tooLong: true };
  const nh = await nameHash(raw);
  const status = Number(await sim(conn!.azns.methods.lease_status(nh)));
  const owner = toAddr(await sim(conn!.azns.methods.owner_of(nh)));
  const mine = !owner.isZero() && owner.equals(activeAccount());
  if (mine && !myNames().some((n) => n.label === label)) {
    // Searching a name you own re-adds it to "My names" (recovers the list
    // after a cleared browser, a new device, etc.). Mode comes from the chain.
    const modeNum = Number(await sim(conn!.azns.methods.mode_of(nh)));
    recordName(label, MODE_NAMES[modeNum] ?? 'PUBLIC');
  }
  return { label, name, len, tooShort: false, tooLong: false, available: status === 0, status, mine };
}

/** Register a name (deploys the account first if needed). */
export async function register(raw: string, mode: ModeName, years: number, onStep: (m: string) => void = () => {}) {
  await connect();
  await ensureWritable(onStep);
  const c = conn!;
  const nh = await nameHash(raw);
  const len = labelLength(raw);
  const modeVal = MODE[mode];
  // Anyone may claim any available name (no proof, no KYC) but registration is
  // PAID: the contract pulls the per-mode fee from your token balance. Verify
  // coverage first so a shortfall is a clear message, not an opaque revert.
  await ensureFeeCovered(modeVal, years);
  onStep(`Registering ${normaliseName(raw)}…`);
  // The packed label is minted back to the owner as an encrypted on-chain
  // backup, so any browser/device with these keys can rebuild "My names".
  const az = azMode();
  if (az) {
    // One wallet tx: authorize the fee pull + register. Azguard proves + pays.
    await azSendTx([
      ...(await azFeeAuthwitActions(modeVal, years, az.address)),
      { kind: 'call', contract: c.azns.address.toString(), method: 'register', args: [nh.toString(), packLabel(raw).toString(), len, az.address, years, modeVal] },
    ]);
    // Publish the discovery key while the user is already in a signing flow
    // (the background watcher never prompts an external wallet unasked).
    ensureBeaconKey(onStep).catch(() => { /* next write retries */ });
  } else {
    await sendRetry(() => c.azns.methods.register(nh, packLabel(raw), len, c.account, years, modeVal));
  }
  recordName(raw, mode, years);
  if (mode === 'STEALTH') {
    // Stealth names need a published meta-key before anyone can pay them -
    // do it automatically so registration is one action for the user.
    try {
      await publishStealth(raw, onStep);
    } catch (e: any) {
      onStep(`Registered. The stealth key didn't publish (${e?.message ?? 'error'}) — you can publish it from My names.`);
    }
  }
}

// ---- "My names": tracked client-side (the chain stores hashes, not labels) ----
// The chain stores only name *hashes*, so a wallet cannot enumerate the labels
// it owns. We remember them per-browser in localStorage, SCOPED TO THE REGISTRY
// CONTRACT - a redeploy (new address, fresh state) must never show names from
// an old deployment. On-chain lease_status/owner_of/mode_of/expiry_of are the
// source of truth; searching a name you own re-adds it to the list automatically.
const LS_NAMES = `azns.mynames.${REGISTRY_TAG}`;
// Scoped per registry AND per active account: the embedded wallet keeps the
// base key (also the pre-connect default, since a browser is always embedded
// until the user connects an external wallet), while each external account
// gets its own suffix - otherwise connecting Azguard would show the embedded
// account's names as the wallet's own.
const namesKey = () => { const a = azMode(); return a ? `${LS_NAMES}.az.${a.address.slice(0, 18)}` : LS_NAMES; };
export type MyName = { label: string; mode: ModeName; registeredAt?: number; years?: number };

// One-time migration: drop the pre-scoping global names key (replaced by the
// per-registry LS_NAMES). Runs once on module load, not on every read.
try { globalThis.localStorage?.removeItem('azns.mynames'); } catch { /* no localStorage */ }

export function myNames(): MyName[] {
  try {
    const list = JSON.parse(lsGet(namesKey()) || '[]');
    return Array.isArray(list) ? list.filter((n) => n && typeof n.label === 'string') : [];
  } catch { return []; }
}
function saveNames(list: MyName[]) { lsSet(namesKey(), JSON.stringify(list)); }

function recordName(raw: string, mode: ModeName, years = 1) {
  const label = raw.trim().toLowerCase().replace(/\.tru$/, '');
  const list = myNames().filter((n) => n.label !== label);
  list.unshift({ label, mode, registeredAt: Number(nowSecs()), years });
  saveNames(list);
}
export function forgetName(label: string) {
  saveNames(myNames().filter((n) => n.label !== label));
}
/** Bump the stored lease length after a local renewal (keeps the expiry estimate fresh). */
export function recordRenewal(label: string, addYears = 1) {
  const list = myNames();
  const n = list.find((x) => x.label === label);
  if (n) { n.years = (n.years ?? 1) + addYears; saveNames(list); }
}
/** Estimated expiry (unix seconds) from stored metadata; null if unknown. */
export function estimatedExpiry(n: MyName): number | null {
  return n.registeredAt ? n.registeredAt + (n.years ?? 1) * Number(ONE_YEAR_SECS) : null;
}
const MODE_NAMES: ModeName[] = ['PUBLIC', 'SELECTIVE', 'STEALTH'];

/** Rebuild "My names" from the encrypted on-chain label backups (LabelNotes).
 *  This is what makes the list follow the ACCOUNT instead of the browser:
 *  a fresh browser/device with the same keys decrypts the backups, re-derives
 *  each name hash, keeps only names this account still owns, and merges them
 *  into the local list. Returns how many names were added. */
export async function restoreMyNames(): Promise<number> {
  await connect();
  // Label backups are PRIVATE notes of the active account - read them from the
  // wallet that holds that account's keys.
  const az = azMode();
  if (az) await ensureAzContracts();
  const out: any = az
    ? await azUtility(conn!.azns.address.toString(), 'my_labels', [])
    : await sim(conn!.azns.methods.my_labels());
  const fields: any[] = Array.isArray(out) ? out : [];
  let added = 0;
  for (const f of fields) {
    let v: bigint;
    try { v = BigInt((f && f.toString) ? f.toString() : f ?? 0); } catch { continue; }
    if (v === 0n) continue;
    const label = unpackLabel(v);
    if (!label || myNames().some((n) => n.label === label)) continue;
    try {
      // The backup is unverified by the contract - check it against the public
      // registry before trusting it.
      const nh = await nameHash(label);
      const owner = toAddr(await sim(conn!.azns.methods.owner_of(nh)));
      if (!owner.equals(activeAccount())) continue;
      const modeNum = Number(await sim(conn!.azns.methods.mode_of(nh)));
      recordName(label, MODE_NAMES[modeNum] ?? 'PUBLIC');
      added++;
    } catch { /* malformed backup - skip */ }
  }
  return added;
}

/** Full on-chain state for a name: lease status, ownership, mode and expiry.
 *  This is the source of truth the dashboard renders from (local storage only
 *  remembers which labels to ask about). */
export async function nameStatus(label: string): Promise<{ status: number; mine: boolean; mode: ModeName | null; expiry: number | null }> {
  await connect();
  const nh = await nameHash(label);
  const status = Number(await sim(conn!.azns.methods.lease_status(nh)));
  const owner = toAddr(await sim(conn!.azns.methods.owner_of(nh)));
  const mine = !owner.isZero() && owner.equals(activeAccount());
  if (status === 0) return { status, mine, mode: null, expiry: null };
  const modeNum = Number(await sim(conn!.azns.methods.mode_of(nh)));
  const expiry = Number(await sim(conn!.azns.methods.expiry_of(nh)));
  return { status, mine, mode: MODE_NAMES[modeNum] ?? null, expiry: expiry > 0 ? expiry : null };
}

export async function resolvePublic(raw: string): Promise<string> {
  await connect();
  return toAddr(await sim(conn!.azns.methods.resolve_public(await nameHash(raw)))).toString();
}

/** Parse a user-supplied Aztec address with a friendly error. */
function parseAddress(input: string, what = 'address'): AztecAddress {
  const v = input.trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(v)) throw new Error(`That doesn't look like a valid Aztec ${what} (expected 0x… hex).`);
  try { return AztecAddress.fromStringUnsafe(v); }
  catch { throw new Error(`That ${what} isn't a valid Aztec address.`); }
}

/** Accept either a raw Aztec address or a public .tru name and return the
 *  address. "grant access to bob.tru" beats pasting hex. */
export async function resolveNameOrAddress(input: string, what = 'address'): Promise<AztecAddress> {
  const v = input.trim();
  if (!v) throw new Error(`Enter an ${what}.`);
  if (!v.startsWith('0x')) {
    await connect();
    const addr = toAddr(await sim(conn!.azns.methods.resolve_public(await nameHash(v))));
    if (addr.isZero()) throw new Error(`"${normaliseName(v)}" doesn't resolve publicly — paste an Aztec address, or use a public name.`);
    return addr;
  }
  return parseAddress(v, what);
}

export async function setPublicTarget(raw: string, target: string, onStep: (m: string) => void = () => {}) {
  await connect(); await ensureWritable(onStep);
  const to = await resolveNameOrAddress(target, 'target address');
  onStep('Saving…');
  const az = azMode();
  if (az) {
    await azSendTx([{ kind: 'call', contract: conn!.azns.address.toString(), method: 'set_public_target', args: [(await nameHash(raw)).toString(), to.toString()] }]);
  } else {
    await send(conn!.azns.methods.set_public_target(await nameHash(raw), to));
  }
}

/** Renew a lease. The contract prices by mode and verifies the claimed mode
 *  against public storage, so a wrong mode here reverts (no underpaying). */
export async function renew(raw: string, mode: ModeName, years: number, onStep: (m: string) => void = () => {}) {
  await connect(); await ensureWritable(onStep);
  // Renewal is charged the same per-mode fee as registration — check coverage.
  await ensureFeeCovered(MODE[mode], years);
  onStep('Renewing…');
  const nh = await nameHash(raw);
  const az = azMode();
  if (az) {
    await azSendTx([
      ...(await azFeeAuthwitActions(MODE[mode], years, az.address)),
      { kind: 'call', contract: conn!.azns.address.toString(), method: 'renew', args: [nh.toString(), MODE[mode], years] },
    ]);
  } else {
    await sendRetry(() => conn!.azns.methods.renew(nh, MODE[mode], years));
  }
  recordRenewal(raw.trim().toLowerCase().replace(/\.tru$/, ''), years);
}

// =============================================================================
//  Multichain address records (ENS-style): a public name can point at MANY
//  chains at once - each record is keyed by a SLIP-0044/ENSIP-11 coin type
//  (see chains.ts for the registry + per-chain address codecs). On-chain an
//  AddrRecord is { hi, lo, len }: two field-packed halves of up to 31 bytes
//  each (62 bytes total - enough for any Bitcoin scriptPubKey), opaque to the
//  contract.
// =============================================================================
import { CHAINS, chainByKey, parseAddress as parseChainAddress, formatAddress, type Chain } from './chains';
export { CHAINS, type Chain };

function packRecordBytes(bytes: Uint8Array): { hi: bigint; lo: bigint; len: number } {
  if (bytes.length === 0 || bytes.length > 62) throw new Error('record must be 1-62 bytes');
  const toBig = (a: Uint8Array) => a.reduce((acc, b) => (acc << 8n) + BigInt(b), 0n);
  return { hi: toBig(bytes.slice(0, 31)), lo: toBig(bytes.slice(31)), len: bytes.length };
}
function unpackRecordBytes(hi: bigint, lo: bigint, len: number): Uint8Array {
  if (len <= 0 || len > 62) return new Uint8Array(0);
  const part = (v: bigint, n: number) => {
    const out = new Uint8Array(n);
    for (let i = n - 1; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
    return out;
  };
  const hiLen = Math.min(len, 31), loLen = len - hiLen;
  return new Uint8Array([...part(hi, hiLen), ...part(lo, loLen)]);
}

const big = (v: any): bigint => BigInt((v && v.toString) ? v.toString() : v);

/** Point a public name at an address on a chain (validates + encodes per chain). */
export async function setRecord(raw: string, chainKey: string, address: string, onStep: (m: string) => void = () => {}) {
  await connect(); await ensureWritable(onStep);
  const chain = chainByKey(chainKey);
  const bytes = await parseChainAddress(chain, address); // throws a friendly error if invalid
  const { hi, lo, len } = packRecordBytes(bytes);
  onStep(`Saving ${chain.label} record…`);
  const az = azMode();
  if (az) {
    await azSendTx([{ kind: 'call', contract: conn!.azns.address.toString(), method: 'set_addr', args: [(await nameHash(raw)).toString(), chain.coinType, hi.toString(), lo.toString(), len] }]);
  } else {
    await send(conn!.azns.methods.set_addr(await nameHash(raw), chain.coinType, hi, lo, len));
  }
}

/** Read the address a name points to on one chain. '' if unset. */
export async function getRecord(raw: string, chainKey: string): Promise<string> {
  await connect();
  const chain = chainByKey(chainKey);
  const rec: any = await sim(conn!.azns.methods.get_addr(await nameHash(raw), chain.coinType));
  const bytes = unpackRecordBytes(big(rec.hi), big(rec.lo), Number(big(rec.len)));
  return bytes.length ? formatAddress(chain, bytes) : '';
}

/** All records a name points to, across every known chain (set ones only). */
export async function getAllRecords(raw: string): Promise<{ chain: Chain; address: string }[]> {
  await connect();
  const nh = await nameHash(raw);
  const out: { chain: Chain; address: string }[] = [];
  // Sequential on purpose: each read is a quick public simulate, and the PXE
  // handles one simulation at a time.
  for (const chain of CHAINS) {
    const rec: any = await sim(conn!.azns.methods.get_addr(nh, chain.coinType));
    const bytes = unpackRecordBytes(big(rec.hi), big(rec.lo), Number(big(rec.len)));
    if (bytes.length) out.push({ chain, address: await formatAddress(chain, bytes) });
  }
  return out;
}

// =============================================================================
//  Private payments (Option 1): resolve a name's Aztec address and pay it with
//  a PRIVATE transfer only. There is deliberately NO public-transfer path here,
//  so amounts/recipients never appear on the explorer. Requires a token address
//  (process.env.PAY_TOKEN_ADDRESS); on Aztec, transfers are private by default.
// =============================================================================
const LS_TOKEN = 'azns.token';
/** Configured fallback token: env first, else one this browser deployed. Used
 *  only when the contract predates the payment_token() view. */
export function tokenAddress(): string {
  const env = process.env.PAY_TOKEN_ADDRESS;
  return (env && env.length > 0) ? env : (lsGet(LS_TOKEN) || '');
}
let cachedPayToken: string | null = null;
/** The token the AZNS contract charges fees in — the single source of truth,
 *  read from its payment_token() view and cached. Everything money-related (the
 *  fee charge, balance, faucet, name payments) uses THIS token, so the authwit
 *  the wallet builds always targets the token the contract will actually pull. */
export async function paymentToken(): Promise<string> {
  if (cachedPayToken) return cachedPayToken;
  await connect();
  try {
    const t = toAddr(await sim(conn!.azns.methods.payment_token()));
    if (!t.isZero()) return (cachedPayToken = t.toString());
  } catch { /* older contract without the view — fall back to config */ }
  const fallback = tokenAddress();
  if (!fallback) throw new Error('This registry has no payment token configured.');
  return (cachedPayToken = fallback);
}
// A fresh PXE only knows contracts it deployed; register the token INSTANCE from
// the node before use (idempotent; connect() already does this for the configured
// token, this covers any others) so private balance reads + the fee-charge
// simulation can find it. Serialized via withPxe to respect the one-job PXE.
const registeredTokens = new Set<string>();
async function tokenAt(addr: string) {
  const { TokenContract } = await import('@aztec/noir-contracts.js/Token');
  if (!registeredTokens.has(addr)) {
    registeredTokens.add(addr);
    await withPxe(async () => {
      try {
        const inst = await conn!.node.getContract(AztecAddress.fromStringUnsafe(addr));
        if (inst) await conn!.wallet.registerContract(inst, TokenContract.artifact);
      } catch { /* already registered or unavailable */ }
    });
  }
  return TokenContract.at(AztecAddress.fromStringUnsafe(addr), conn!.wallet);
}

// Open-mint Faucet binding, registered in the PXE like the token. When a
// FAUCET_ADDRESS is configured, claims go through it so ANY account can get test
// tokens (the faucet is an approved token minter, minting to the caller).
const registeredFaucets = new Set<string>();
async function faucetAt(addr: string) {
  const { FaucetContract } = await import('./contracts/Faucet');
  if (!registeredFaucets.has(addr)) {
    registeredFaucets.add(addr);
    await withPxe(async () => {
      try {
        const inst = await conn!.node.getContract(AztecAddress.fromStringUnsafe(addr));
        if (inst) await conn!.wallet.registerContract(inst, FaucetContract.artifact);
      } catch { /* already registered or unavailable */ }
    });
  }
  return FaucetContract.at(AztecAddress.fromStringUnsafe(addr), conn!.wallet);
}

/** Faucet: get test tokens for the registry's payment token. Uses the open-mint
 *  Faucet contract (FAUCET_ADDRESS) so any account self-serves; falls back to a
 *  direct mint for local dev where this account is the token's own minter. */
export async function getTestTokens(amount: bigint, onStep: (m: string) => void = () => {}): Promise<string> {
  await connect(); await ensureWritable(onStep);
  const addr = await paymentToken();
  const faucetAddr = (process.env.FAUCET_ADDRESS && process.env.FAUCET_ADDRESS.length > 0) ? process.env.FAUCET_ADDRESS : '';
  onStep('Claiming test tokens…');
  try {
    const az = azMode();
    if (az && faucetAddr) {
      await azSendTx([{ kind: 'call', contract: faucetAddr, method: 'claim', args: [amount.toString()] }]);
    } else if (az) {
      await azSendTx([{ kind: 'call', contract: addr, method: 'mint_to_private', args: [az.address, amount.toString()] }]);
    } else if (faucetAddr) {
      const faucet = await faucetAt(faucetAddr);
      await sendRetry(() => faucet.methods.claim(amount));
    } else {
      const token = await tokenAt(addr); // local dev: this account can mint directly
      await sendRetry(() => token.methods.mint_to_private(conn!.account, amount));
    }
  } catch (e: any) {
    throw new Error(`Couldn't get test tokens (${e?.message ?? 'try again'}).${faucetAddr ? '' : ' No faucet configured for this registry.'}`);
  }
  // This credit is a self-mint, not an incoming payment - tell the watcher to
  // absorb the next balance increase silently (no "Payment received" toast).
  suppressIncreaseUntil = Date.now() + 5 * 60 * 1000;
  // External wallet: publish the discovery key while the user is already in a
  // signing flow (the watcher never prompts an external wallet unasked).
  if (azMode()) ensureBeaconKey(onStep).catch(() => { /* next write retries */ });
  return addr;
}

/** Your private balance of the registry's payment token (null if unavailable).
 *  Private state lives in the ACTIVE wallet: Azguard's PXE when connected. */
export async function tokenBalance(): Promise<bigint | null> {
  await connect();
  let addr: string;
  try { addr = await paymentToken(); } catch { return null; }
  const a = azMode();
  if (a) {
    await ensureAzContracts();
    const v = await azUtility(addr, 'balance_of_private', [a.address]);
    return BigInt((v && v.toString) ? v.toString() : v ?? 0);
  }
  const token = await tokenAt(addr);
  return BigInt((await sim(token.methods.balance_of_private(conn!.account))).toString());
}

// ---- Automatic payment detection ----------------------------------------------
// Aztec wallets discover incoming private notes when they sync; nothing about a
// payment is ever public. This watcher surfaces that automatically: it polls the
// private balance in the background and reports increases, so owners of stealth
// (or any) names see "payment received" without checking anything by hand.
let watcherTimer: ReturnType<typeof setInterval> | null = null;
// Set by getTestTokens so a self-mint's balance bump isn't reported as a payment.
let suppressIncreaseUntil = 0;
export function startPaymentWatcher(
  onPayment: (delta: bigint, balance: bigint) => void,
  onBalance?: (balance: bigint) => void,
  intervalMs = 20000,
) {
  stopPaymentWatcher();
  let last: bigint | null = null;
  let lastFor = ''; // which account the baseline belongs to
  let beaconKeyAttempted = false;
  const tick = async () => {
    if (txInFlight > 0) return; // never compete with an in-flight proof
    // Discover payments announced to us (beacon): register any new payers so
    // the balance read below sees their notes — the increase then surfaces
    // through the normal "payment received" path.
    try {
      await scanBeaconPayments();
      // Publish the discovery key opportunistically for the EMBEDDED wallet
      // only: it signs silently. An external wallet would pop a signing
      // prompt out of nowhere on a background tick — its key is published
      // right after a user-initiated write instead (register/getTestTokens).
      if (!beaconKeyAttempted && !azMode() && lsGet(LS.accountDeployed)) {
        beaconKeyAttempted = true; // one shot per session; reset on failure
        ensureBeaconKey().catch(() => { beaconKeyAttempted = false; });
      }
    } catch { /* node hiccup — beacon scan resumes next tick */ }
    try {
      const bal = await tokenBalance();
      if (bal === null) return;
      // Re-baseline when the ACTIVE ACCOUNT changed (connecting/disconnecting
      // an external wallet): comparing another account's balance against the
      // previous one would fire a false "payment received".
      const who = accountAddress() ?? '';
      if (who !== lastFor) { lastFor = who; last = bal; onBalance?.(bal); return; }
      onBalance?.(bal);
      if (last !== null && bal > last) {
        if (Date.now() < suppressIncreaseUntil) suppressIncreaseUntil = 0; // self-mint: absorb once
        else onPayment(bal - last, bal);
      }
      last = bal;
    } catch { /* node hiccup - try again next tick */ }
  };
  tick();
  watcherTimer = setInterval(tick, intervalMs);
}
export function stopPaymentWatcher() {
  if (watcherTimer) { clearInterval(watcherTimer); watcherTimer = null; }
}

/** How a name can be paid: resolve public target, else stealth (owner), else not payable. */
export async function payTarget(raw: string): Promise<{ to: AztecAddress; kind: 'public' | 'stealth' } | null> {
  await connect();
  const nh = await nameHash(raw);
  // Never resolve-for-pay a name whose lease has lapsed (status 0 = available
  // or past grace): the fixed contract already zeroes stale resolutions, but
  // guard client-side too so an older/other registry can't misdirect a payment
  // to a previous owner (audit #1). Active (1) and grace (2) still pay.
  const status = Number(await sim(conn!.azns.methods.lease_status(nh)));
  if (status === 0) return null;
  const pub = toAddr(await sim(conn!.azns.methods.resolve_public(nh)));
  if (!pub.isZero()) return { to: pub, kind: 'public' };
  const key: any = await sim(conn!.azns.methods.resolve_stealth(nh));
  const hasKey = BigInt((key.spend_x?.toString?.() ?? key.spend_x) || 0) !== 0n;
  if (hasKey) {
    const owner = toAddr(await sim(conn!.azns.methods.owner_of(nh)));
    if (!owner.isZero()) return { to: owner, kind: 'stealth' };
  }
  return null;
}

/** Pay a name with a PRIVATE transfer only (no public path => explorer-invisible). */
export async function payPrivately(raw: string, amount: bigint, onStep: (m: string) => void = () => {}) {
  if (amount <= 0n) throw new Error('Enter an amount greater than zero.');
  await connect(); await ensureWritable(onStep);
  const addr = await paymentToken();
  if (!addr) throw new Error('No token configured for this registry.');
  onStep('Resolving name…');
  const dest = await payTarget(raw);
  if (!dest) throw new Error('This name has no payable address yet.');
  onStep('Sending a private transfer…');
  const az = azMode();
  if (az) {
    // One ATOMIC wallet tx: transfer + beacon announce together (the embedded
    // path needs two txs; the wallet's action batch does it in one).
    const actions: any[] = [{ kind: 'call', contract: addr, method: 'transfer', args: [dest.to.toString(), amount.toString()] }];
    try { const a = await azAnnounceAction(dest.to); if (a) actions.push(a); } catch { /* announce optional */ }
    await azSendTx(actions);
  } else {
    const token = await tokenAt(addr);
    await send(token.methods.transfer(dest.to, amount)); // PRIVATE transfer only
    // Make it discoverable: announce under the recipient's beacon tag (no-op if
    // they never published a key). The payment itself is already final — an
    // announce failure must never surface as a payment failure.
    try { await announcePayment(dest.to, onStep); } catch { /* recipient can still revealFrom */ }
  }
  onStep('Paid privately.');
}

// ---- Stealth meta-key (publish + status) -------------------------------------
// Scoped to the registry like the names list: a key published on one deployment
// must not silently resurface on another.
const lsStealth = (name: string) => `azns.stealth.${REGISTRY_TAG}.${name}`;
export async function publishStealth(raw: string, onStep: (m: string) => void = () => {}) {
  await connect(); await ensureWritable(onStep);
  const { Grumpkin } = await import('@aztec/foundation/crypto/grumpkin');
  const { GrumpkinScalar } = await import('@aztec/foundation/curves/grumpkin');
  const name = normaliseName(raw);
  let s, v;
  const stored = lsGet(lsStealth(name));
  if (stored) { const o = JSON.parse(stored); s = GrumpkinScalar.fromString(o.s); v = GrumpkinScalar.fromString(o.v); }
  else { s = GrumpkinScalar.random(); v = GrumpkinScalar.random(); lsSet(lsStealth(name), JSON.stringify({ s: s.toString(), v: v.toString() })); }
  const S = await Grumpkin.mul(Grumpkin.generator, s);
  const V = await Grumpkin.mul(Grumpkin.generator, v);
  onStep('Publishing your stealth key…');
  const az = azMode();
  if (az) {
    await azSendTx([{
      kind: 'call', contract: conn!.azns.address.toString(), method: 'set_stealth_meta',
      args: [(await nameHash(raw)).toString(), { spend_x: S.x.toString(), spend_y: S.y.toString(), view_x: V.x.toString(), view_y: V.y.toString() }],
    }]);
  } else {
    await send(conn!.azns.methods.set_stealth_meta(await nameHash(raw),
      { spend_x: S.x, spend_y: S.y, view_x: V.x, view_y: V.y }));
  }
  onStep('Stealth key published — anyone can now pay this name privately.');
}
/** True if a stealth meta-key has been published for the name. */
export async function hasStealthKey(raw: string): Promise<boolean> {
  await connect();
  const k: any = await sim(conn!.azns.methods.resolve_stealth(await nameHash(raw)));
  return !(BigInt((k.spend_x?.toString?.() ?? k.spend_x) || 0) === 0n);
}

export function accountAddress(): string | null {
  const a = azMode();
  if (a) return a.address;
  return conn ? conn.account.toString() : null;
}
/** How testnet fees are being paid once connected: native fee juice vs sponsored FPC. */
export function feeMode(): { funded: boolean; label: string } | null {
  return conn ? { funded: conn.funded, label: conn.feeLabel } : null;
}
export const isLocal = IS_LOCAL;

export async function hardReset(): Promise<void> {
  // Every key this dApp owns (names, stealth secrets, beacon bookkeeping,
  // wallet flags) plus the Azguard client-lib's session key — not just the
  // handful in LS. Enumerate first: removing while iterating skips keys.
  try {
    const ls = globalThis.localStorage;
    if (ls) {
      const doomed: string[] = [];
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k && (k.startsWith('azns.') || k.startsWith('azguard:'))) doomed.push(k);
      }
      doomed.forEach((k) => ls.removeItem(k));
    }
  } catch { /* best effort */ }
  // Older builds kept the PXE in IndexedDB; the nightly keeps it in OPFS
  // (SQLite worker). Wipe both so the reset actually resets the wallet state.
  try {
    const idb: any = globalThis.indexedDB;
    if (idb?.databases) { const dbs = await idb.databases(); await Promise.all(dbs.map((d: any) => d?.name && idb.deleteDatabase(d.name))); }
  } catch { /* best effort */ }
  try {
    const root: any = await (globalThis.navigator as any)?.storage?.getDirectory?.();
    if (root?.entries) {
      const names: string[] = [];
      for await (const [name] of root.entries()) names.push(name);
      await Promise.all(names.map((n) => root.removeEntry(n, { recursive: true }).catch(() => { /* locked by a live worker - dies with the reload */ })));
    }
  } catch { /* best effort */ }
  globalThis.location?.reload();
}

/** Send a PRIVATE transfer of the registry's payment token straight to a raw
 *  address (no name resolution) — the same private path payPrivately uses, for
 *  moving test tokens between accounts. Returns the recipient + amount sent. */
export async function payToAddress(addressStr: string, amount: bigint, onStep: (m: string) => void = () => {}) {
  if (amount <= 0n) throw new Error('Enter an amount greater than zero.');
  await connect(); await ensureWritable(onStep);
  const to = parseAddress(addressStr, 'recipient');
  const addr = await paymentToken();
  if (!addr) throw new Error('No token configured for this registry.');
  const bal = (await tokenBalance()) ?? 0n;
  if (bal < amount) throw new Error(`Balance (${bal}) is less than the amount you tried to send (${amount}).`);
  onStep('Sending a private transfer…');
  const az = azMode();
  if (az) {
    const actions: any[] = [{ kind: 'call', contract: addr, method: 'transfer', args: [to.toString(), amount.toString()] }];
    try { const a = await azAnnounceAction(to); if (a) actions.push(a); } catch { /* announce optional */ }
    await azSendTx(actions);
  } else {
    const token = await tokenAt(addr);
    await sendRetry(() => token.methods.transfer(to, amount)); // PRIVATE transfer only
    try { await announcePayment(to, onStep); } catch { /* recipient can still revealFrom */ }
  }
  onStep('Sent.');
  return { to: to.toString(), amount: amount.toString() };
}

/** Reveal incoming private payments from a given sender. In Aztec a wallet only
 *  discovers notes from senders it has REGISTERED (notes from your own txs
 *  aside) — so a transfer INTO this account stays invisible until you register
 *  the payer. This registers them and re-reads the balance (the read triggers a
 *  PXE sync, which then scans historical logs for that sender's tagged notes).
 *  Must be run in a wallet that holds THIS account's keys (i.e. the recipient). */
export async function revealFrom(senderStr: string): Promise<{ account: string; registered: string; balanceTokens: string }> {
  await connect();
  const sender = parseAddress(senderStr, 'sender');
  if (azMode()) await azRegisterSender(sender.toString());
  else await withPxe(() => conn!.wallet.registerSender(sender, sender.toString()));
  const bal = (await tokenBalance()) ?? 0n; // the read syncs the active wallet first
  return { account: activeAccount().toString(), registered: sender.toString(), balanceTokens: (bal / (10n ** 18n)).toString() };
}

// ---- Payment-discovery beacon (Option A) --------------------------------------
// Solves "the recipient must know the sender to see a payment": the payer
// ANNOUNCES each payment on the Beacon contract under a tag derived from the
// RECIPIENT's published beacon key; the recipient scans its own tag straight
// on the node (no PXE, no sender knowledge, no off-chain channel), decrypts
// the payer, registers it as a sender, and the payment note appears. The
// payload is ECDH-encrypted to the beacon key, so an observer who derives the
// (public) tag learns only THAT a payment arrived — never from whom nor how
// much. Transport proven live on testnet by scripts/beacon_a_e2e.ts.
const BEACON_ADDRESS = (process.env.BEACON_ADDRESS && process.env.BEACON_ADDRESS.length > 0) ? process.env.BEACON_ADDRESS : '';
const BEACON_DOMAIN = 0x747275n; // "tru" — domain-separates every beacon hash
const LS_BEACON_KEY = `azns.beacon.key.${REGISTRY_TAG}`;
const LS_BEACON_SEEN = `azns.beacon.seen.${REGISTRY_TAG}`;
// Beacon bookkeeping is scoped per ACTIVE ACCOUNT (embedded or external): a
// hardReset mints a fresh embedded account, and one browser may connect
// different external accounts over time — a stale registry-wide "key
// published" flag would silently skip publishing for the new account and
// break its payment discovery. Losing the flag is harmless: ensureBeaconKey
// re-checks the on-chain key first.
const beaconScope = () => { try { return activeAccount().toString().slice(0, 18); } catch { return 'none'; } };
const beaconFlagKey = () => `${LS_BEACON_KEY}.${beaconScope()}`;
const beaconSeenKey = () => `${LS_BEACON_SEEN}.${beaconScope()}`;

async function grumpkinLib() {
  const { Grumpkin } = await import('@aztec/foundation/crypto/grumpkin');
  const { GrumpkinScalar, Point } = await import('@aztec/foundation/curves/grumpkin');
  return { Grumpkin, GrumpkinScalar, Point };
}
/** The active account's beacon keypair. Embedded: derived from the wallet
 *  secret (follows the account anywhere, nothing extra to back up). Azguard:
 *  a dedicated per-account discovery keypair kept in this browser — we can't
 *  derive from the external wallet's secret. Regenerable: a lost key just
 *  means re-registering; history stays recoverable via revealFrom. */
async function beaconKeys() {
  const { Grumpkin, GrumpkinScalar } = await grumpkinLib();
  let priv;
  const a = azMode();
  if (a) {
    const k = `azns.beacon.azpriv.${a.address.slice(0, 18)}`;
    let stored = lsGet(k);
    if (!stored) { stored = GrumpkinScalar.random().toString(); lsSet(k, stored); }
    priv = GrumpkinScalar.fromString(stored);
  } else {
    const secret = lsGet(LS.secret);
    if (!secret) throw new Error('connect first');
    const seed = await poseidon2Hash([Fr.fromString(secret), new Fr(BEACON_DOMAIN)]);
    priv = GrumpkinScalar.fromString(seed.toString());
  }
  const pub = await Grumpkin.mul(Grumpkin.generator, priv);
  return { priv, pub };
}
const registeredBeacons = new Set<string>();
async function beaconAt(addr: string) {
  const { BeaconContract } = await import('./contracts/Beacon');
  if (!registeredBeacons.has(addr)) {
    registeredBeacons.add(addr);
    await withPxe(async () => {
      try {
        const inst = await conn!.node.getContract(AztecAddress.fromStringUnsafe(addr));
        if (inst) await conn!.wallet.registerContract(inst, BeaconContract.artifact);
      } catch { /* already registered or unavailable */ }
    });
  }
  return BeaconContract.at(AztecAddress.fromStringUnsafe(addr), conn!.wallet);
}
// One well-known tag per beacon key: the node returns EVERY log under a tag,
// so payers need no index coordination (rotation is a later perf/privacy step).
const beaconTag = async (kx: Fr, ky: Fr) =>
  poseidon2Hash([await poseidon2Hash([kx, ky, new Fr(BEACON_DOMAIN)]), new Fr(0)]);

/** Publish this account's beacon key (one-time) so payments to it become
 *  auto-discoverable. Quietly does nothing until the account is deployed. */
export async function ensureBeaconKey(onStep: (m: string) => void = () => {}): Promise<boolean> {
  if (!BEACON_ADDRESS) return false;
  await connect();
  if (lsGet(beaconFlagKey())) return true;
  const beacon = await beaconAt(BEACON_ADDRESS);
  try {
    const k: any = await sim(beacon.methods.key_of(activeAccount()));
    if (BigInt((k?.x?.toString?.() ?? k?.x) || 0) !== 0n) { lsSet(beaconFlagKey(), '1'); return true; }
  } catch { /* unreadable — try to register below */ }
  const az = azMode();
  if (!az && !lsGet(LS.accountDeployed)) return false; // a key without an account helps nobody
  const { pub } = await beaconKeys();
  onStep('Publishing your discovery key (one-time)…');
  if (az) {
    await ensureAzContracts();
    await azSendTx([{ kind: 'call', contract: BEACON_ADDRESS, method: 'register_key', args: [pub.x.toString(), pub.y.toString()] }]);
  } else {
    await sendRetry(() => beacon.methods.register_key(pub.x, pub.y));
  }
  lsSet(beaconFlagKey(), '1');
  return true;
}

/** Build the encrypted announce payload for a recipient, or null when they
 *  have no published beacon key. The encrypted payer = the ACTIVE account. */
async function buildAnnounce(recipient: AztecAddress): Promise<{ tag: Fr; ex: Fr; ey: Fr; ct: Fr } | null> {
  if (!BEACON_ADDRESS) return null;
  const beacon = await beaconAt(BEACON_ADDRESS);
  const k: any = await sim(beacon.methods.key_of(recipient));
  const kx = BigInt((k?.x?.toString?.() ?? k?.x) || 0);
  const ky = BigInt((k?.y?.toString?.() ?? k?.y) || 0);
  if (kx === 0n) return null; // recipient not discoverable (no key published)
  const { Grumpkin, GrumpkinScalar, Point } = await grumpkinLib();
  const K = new Point(new Fr(kx), new Fr(ky));
  const e = GrumpkinScalar.random();
  const E = await Grumpkin.mul(Grumpkin.generator, e); // goes in the payload
  const S = await Grumpkin.mul(K, e);                  // ECDH shared secret
  const mask = await poseidon2Hash([S.x, S.y, new Fr(BEACON_DOMAIN)]);
  const ct = new Fr((activeAccount().toBigInt() + mask.toBigInt()) % Fr.MODULUS);
  const tag = await beaconTag(new Fr(kx), new Fr(ky));
  return { tag, ex: E.x, ey: E.y, ct };
}
/** As a CallAction for an Azguard tx (null when the recipient has no key). */
async function azAnnounceAction(recipient: AztecAddress): Promise<any | null> {
  const p = await buildAnnounce(recipient);
  if (!p) return null;
  return { kind: 'call', contract: BEACON_ADDRESS, method: 'announce', args: [p.tag.toString(), p.ex.toString(), p.ey.toString(), p.ct.toString()] };
}
/** Announce a payment under the RECIPIENT's beacon tag so they discover it
 *  without knowing us (embedded-wallet path). */
async function announcePayment(recipient: AztecAddress, onStep: (m: string) => void = () => {}): Promise<boolean> {
  const p = await buildAnnounce(recipient);
  if (!p) return false;
  onStep('Announcing the payment for auto-discovery…');
  const beacon = await beaconAt(BEACON_ADDRESS);
  await sendRetry(() => beacon.methods.announce(p.tag, p.ex, p.ey, p.ct));
  return true;
}

/** Scan the node for payments announced to US; register each decrypted payer
 *  as a sender so their notes appear. Returns how many new payers surfaced. */
export async function scanBeaconPayments(): Promise<number> {
  if (!BEACON_ADDRESS) return 0;
  await connect();
  const { priv, pub } = await beaconKeys();
  const { Tag, SiloedTag } = await import('@aztec/stdlib/logs');
  const raw = await beaconTag(pub.x, pub.y);
  const siloed = await SiloedTag.computeFromTagAndApp(new Tag(raw), AztecAddress.fromStringUnsafe(BEACON_ADDRESS));
  const res: any[][] = await conn!.node.getPrivateLogsByTags({ tags: [siloed] });
  const logs: any[] = res?.[0] ?? [];
  if (logs.length === 0) return 0;
  const seen = new Set<string>(JSON.parse(lsGet(beaconSeenKey()) || '[]'));
  const { Grumpkin, Point } = await grumpkinLib();
  let found = 0;
  for (const log of logs) {
    const f: any[] = log?.logData ?? [];
    const id = `${log?.txHash ?? ''}:${log?.logIndexWithinTx ?? ''}`;
    if (seen.has(id) || f.length < 4) continue;
    seen.add(id); // one attempt per log — a malformed log stays ignored
    try {
      // logData: [tag, E.x, E.y, ct]
      const E = new Point(Fr.fromString(f[1].toString()), Fr.fromString(f[2].toString()));
      const S = await Grumpkin.mul(E, priv);
      const mask = await poseidon2Hash([S.x, S.y, new Fr(BEACON_DOMAIN)]);
      const payerB = ((BigInt(f[3].toString()) - mask.toBigInt()) % Fr.MODULUS + Fr.MODULUS) % Fr.MODULUS;
      const payer = AztecAddress.fromFieldUnsafe(new Fr(payerB));
      if (payer.isZero() || payer.equals(activeAccount())) continue;
      // Register the discovered payer in the ACTIVE wallet's PXE so its notes appear.
      const a = azMode();
      if (a) await azRegisterSender(payer.toString());
      else await withPxe(() => conn!.wallet.registerSender(payer, payer.toString()));
      found++;
    } catch { /* not ours / malformed — skip */ }
  }
  lsSet(beaconSeenKey(), JSON.stringify([...seen]));
  return found;
}

// Console-only debug hook (testnet preview): trigger a raw-address transfer or
// reveal an incoming payment from devtools for manual testing. NOT in the UI.
try {
  if (typeof window !== 'undefined') {
    (window as any).aznsDbg = { payToAddress, revealFrom, paymentToken, tokenBalance, accountAddress, ensureBeaconKey, scanBeaconPayments };
  }
} catch { /* no window */ }
