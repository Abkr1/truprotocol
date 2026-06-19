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
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { AZNSContract } from './contracts/AZNS';
import {
  nameHash, labelLength, normaliseName, packLabel, unpackLabel,
  MODE, MIN_LABEL, MAX_LABEL, ONE_YEAR_SECS, nowSecs, type ModeName,
} from './lib';

const NODE_URL = (process.env.AZTEC_NODE_URL && process.env.AZTEC_NODE_URL.length > 0)
  ? process.env.AZTEC_NODE_URL
  : 'http://localhost:8080';
const IS_LOCAL = /localhost|127\.0\.0\.1/.test(NODE_URL);

const LS = {
  secret: 'azns.secret',
  salt: 'azns.salt',
  accountDeployed: 'azns.accountDeployed',
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
  if (typeof v === 'bigint' || typeof v === 'number') return AztecAddress.fromField(new Fr(BigInt(v)));
  const s = (v && typeof v.toString === 'function') ? v.toString() : String(v);
  return AztecAddress.fromField(Fr.fromString(s));
}

/** Light read-only connect: ready to search, no on-chain account deploy yet. */
export async function connect(log: (m: string) => void = () => {}): Promise<Conn> {
  if (conn) return conn;
  if (connecting) return connecting;
  connecting = (async () => {
    const proverEnabled = !IS_LOCAL; // real proofs on testnet (writes only)
    const wallet = await EmbeddedWallet.create(NODE_URL, { pxe: { proverEnabled } });

    const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(0n) });
    await wallet.registerContract(fpc, SponsoredFPCContract.artifact);
    const node = createAztecNodeClient(NODE_URL);

    // Wallet keys: a funded "house wallet" from env (lets the dApp pay testnet
    // fees from native fee juice, since the shared sponsored FPC is drained),
    // else a per-browser random account.
    const houseSecret = process.env.DAPP_WALLET_SECRET;
    const houseSalt = process.env.DAPP_WALLET_SALT;
    let secret: string | null, salt: string | null;
    if (houseSecret && houseSecret.length > 0 && houseSalt && houseSalt.length > 0) {
      secret = houseSecret; salt = houseSalt;
    } else {
      secret = lsGet(LS.secret); salt = lsGet(LS.salt);
      if (!secret || !salt) {
        secret = Fr.random().toString(); salt = Fr.random().toString();
        lsSet(LS.secret, secret); lsSet(LS.salt, salt);
      }
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
      const inst = await node.getContract(AztecAddress.fromString(known));
      if (inst) await wallet.registerContract(inst, AZNSContract.artifact);
    } catch { /* may already be registered, or sim-only works */ }
    const azns = await AZNSContract.at(AztecAddress.fromString(known), wallet);

    conn = { wallet, account, manager, fee, feeLabel, funded, azns };
    return conn;
  })();
  try { return await connecting; } finally { connecting = null; }
}

const sim = async (interaction: any) => (await interaction.simulate({ from: conn!.account })).result;
// Track in-flight transactions so background polling never competes with the
// prover for the PXE.
let txInFlight = 0;
const send = async (interaction: any) => {
  txInFlight++;
  try { await interaction.send({ from: conn!.account, fee: conn!.fee }); }
  finally { txInFlight--; }
};

/** Deploy the user's account on first write (sponsored). */
async function ensureWritable(onStep: (m: string) => void = () => {}): Promise<void> {
  const c = conn!;
  if (c.funded) { lsSet(LS.accountDeployed, '1'); return; } // funded => already on-chain
  if (lsGet(LS.accountDeployed)) return;
  onStep('Setting up your wallet (one-time)…');
  if (!c.manager) c.manager = await c.wallet.createSchnorrAccount(Fr.fromString(lsGet(LS.secret)!), Fr.fromString(lsGet(LS.salt)!));
  try {
    await (await c.manager.getDeployMethod()).send({ from: NO_FROM, fee: c.fee });
  } catch (e: any) {
    if (!/already|deployed|exist/i.test(e?.message ?? '')) throw e;
  }
  lsSet(LS.accountDeployed, '1');
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
  const mine = !owner.isZero() && owner.equals(conn!.account);
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
  onStep(`Registering ${normaliseName(raw)}…`);
  // Permissionless: anyone may claim any available name. No proof, no KYC.
  // The packed label is minted back to the owner as an encrypted on-chain
  // backup, so any browser/device with these keys can rebuild "My names".
  await send(c.azns.methods.register(nh, packLabel(raw), len, c.account, years, modeVal));
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
const REGISTRY_TAG = (process.env.AZNS_ADDRESS || 'local').toLowerCase().slice(0, 14);
const LS_NAMES = `azns.mynames.${REGISTRY_TAG}`;
export type MyName = { label: string; mode: ModeName; registeredAt?: number; years?: number };

// One-time migration: drop the pre-scoping global names key (replaced by the
// per-registry LS_NAMES). Runs once on module load, not on every read.
try { globalThis.localStorage?.removeItem('azns.mynames'); } catch { /* no localStorage */ }

export function myNames(): MyName[] {
  try {
    const list = JSON.parse(lsGet(LS_NAMES) || '[]');
    return Array.isArray(list) ? list.filter((n) => n && typeof n.label === 'string') : [];
  } catch { return []; }
}
function saveNames(list: MyName[]) { lsSet(LS_NAMES, JSON.stringify(list)); }

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
  const out: any = await sim(conn!.azns.methods.my_labels());
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
      if (!owner.equals(conn!.account)) continue;
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
  const mine = !owner.isZero() && owner.equals(conn!.account);
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
  try { return AztecAddress.fromString(v); }
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
  await send(conn!.azns.methods.set_public_target(await nameHash(raw), to));
}

// ---- Selective mode: per-viewer grants ---------------------------------------
// The owner privately mints a resolution capability to a specific viewer; only
// that viewer can decrypt it. Nothing about who can resolve what appears on-chain.

/** Grant a viewer the (private) ability to resolve this selective name to `target`. */
export async function grantAccess(raw: string, viewer: string, target: string, onStep: (m: string) => void = () => {}) {
  await connect(); await ensureWritable(onStep);
  const nh = await nameHash(raw);
  const viewerAddr = await resolveNameOrAddress(viewer, "viewer's address");
  const targetAddr = await resolveNameOrAddress(target, 'target address');
  onStep('Reading the name epoch…');
  const epoch = BigInt((await sim(conn!.azns.methods.current_epoch(nh))).toString());
  const expiry = nowSecs() + ONE_YEAR_SECS; // capability valid for a year
  onStep('Granting access (private)…');
  await send(conn!.azns.methods.grant(nh, viewerAddr, targetAddr, expiry, epoch));
}

/** Revoke a viewer's resolution capability for this selective name. */
export async function revokeAccess(raw: string, viewer: string, onStep: (m: string) => void = () => {}) {
  await connect(); await ensureWritable(onStep);
  const viewerAddr = await resolveNameOrAddress(viewer, "viewer's address");
  onStep('Revoking access (private)…');
  await send(conn!.azns.methods.revoke(await nameHash(raw), viewerAddr));
}

/** What a selective name resolves to FOR ME (the connected viewer). '' if no access. */
export async function myAccess(raw: string): Promise<string> {
  await connect();
  const nh = await nameHash(raw);
  const epoch = BigInt((await sim(conn!.azns.methods.current_epoch(nh))).toString());
  const out = await sim(conn!.azns.methods.my_resolution(nh, epoch));
  const addr = toAddr(out);
  return addr.isZero() ? '' : addr.toString();
}

/** Renew a lease. The contract prices by mode and verifies the claimed mode
 *  against public storage, so a wrong mode here reverts (no underpaying). */
export async function renew(raw: string, mode: ModeName, years: number, onStep: (m: string) => void = () => {}) {
  await connect(); await ensureWritable(onStep);
  onStep('Renewing…');
  await send(conn!.azns.methods.renew(await nameHash(raw), MODE[mode], years));
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
  await send(conn!.azns.methods.set_addr(await nameHash(raw), chain.coinType, hi, lo, len));
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
/** Configured token: env first, else one this browser deployed (localStorage). */
export function tokenAddress(): string {
  const env = process.env.PAY_TOKEN_ADDRESS;
  return (env && env.length > 0) ? env : (lsGet(LS_TOKEN) || '');
}
async function tokenAt(addr: string) {
  const { TokenContract } = await import('@aztec/noir-contracts.js/Token');
  return TokenContract.at(AztecAddress.fromString(addr), conn!.wallet);
}

/** Faucet: deploy a test token (first time, you're the admin) + mint to yourself. */
export async function getTestTokens(amount: bigint, onStep: (m: string) => void = () => {}): Promise<string> {
  await connect(); await ensureWritable(onStep);
  let addr = tokenAddress();
  const { TokenContract } = await import('@aztec/noir-contracts.js/Token');
  if (!addr) {
    onStep('Deploying a test token (one-time)…');
    const { contract } = await TokenContract.deploy(conn!.wallet, conn!.account, 'tru Test Token', 'TRU', 18)
      .send({ from: conn!.account, fee: conn!.fee });
    addr = contract.address.toString();
    lsSet(LS_TOKEN, addr);
  }
  onStep('Minting test tokens to you…');
  const token = await TokenContract.at(AztecAddress.fromString(addr), conn!.wallet);
  await send(token.methods.mint_to_private(conn!.account, amount));
  // This credit is a self-mint, not an incoming payment - tell the watcher to
  // absorb the next balance increase silently (no "Payment received" toast).
  suppressIncreaseUntil = Date.now() + 5 * 60 * 1000;
  return addr;
}

/** Your private token balance (null if no token configured). */
export async function tokenBalance(): Promise<bigint | null> {
  await connect();
  const addr = tokenAddress(); if (!addr) return null;
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
  const tick = async () => {
    if (txInFlight > 0) return; // never compete with an in-flight proof
    try {
      const bal = await tokenBalance();
      if (bal === null) return;
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
  const addr = tokenAddress();
  if (!addr) throw new Error('No token yet — click "Get test tokens" first.');
  onStep('Resolving name…');
  const dest = await payTarget(raw);
  if (!dest) throw new Error('This name does not accept direct payments (selective names resolve per-viewer).');
  onStep('Sending a private transfer…');
  const token = await tokenAt(addr);
  await send(token.methods.transfer(dest.to, amount)); // PRIVATE transfer only
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
  await send(conn!.azns.methods.set_stealth_meta(await nameHash(raw),
    { spend_x: S.x, spend_y: S.y, view_x: V.x, view_y: V.y }));
  onStep('Stealth key published — anyone can now pay this name privately.');
}
/** True if a stealth meta-key has been published for the name. */
export async function hasStealthKey(raw: string): Promise<boolean> {
  await connect();
  const k: any = await sim(conn!.azns.methods.resolve_stealth(await nameHash(raw)));
  return !(BigInt((k.spend_x?.toString?.() ?? k.spend_x) || 0) === 0n);
}

export function accountAddress(): string | null { return conn ? conn.account.toString() : null; }
/** How testnet fees are being paid once connected: native fee juice vs sponsored FPC. */
export function feeMode(): { funded: boolean; label: string } | null {
  return conn ? { funded: conn.funded, label: conn.feeLabel } : null;
}
export const isLocal = IS_LOCAL;

export async function hardReset(): Promise<void> {
  Object.values(LS).forEach((k) => globalThis.localStorage?.removeItem(k));
  try {
    const idb: any = globalThis.indexedDB;
    if (idb?.databases) { const dbs = await idb.databases(); await Promise.all(dbs.map((d: any) => d?.name && idb.deleteDatabase(d.name))); }
  } catch { /* best effort */ }
  globalThis.location?.reload();
}
