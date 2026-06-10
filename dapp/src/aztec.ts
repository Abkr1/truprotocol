// =============================================================================
//  aztec.ts - browser service layer for the AZNS dApp (consumer-friendly).
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
  nameHash, labelLength, normaliseName, priceCentsForLength,
  MODE, ONE_YEAR_SECS, nowSecs, type ModeName,
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

type Zkp = { vkAsFields: string[]; vkHash: string; proofAsFields: string[]; publicInputs: string[] };
type Manager = Awaited<ReturnType<EmbeddedWallet['createSchnorrAccount']>>;

type Conn = {
  wallet: EmbeddedWallet;
  account: AztecAddress;
  manager: Manager | null;
  fee: any;          // {} = native fee juice; else { paymentMethod: SponsoredFeePaymentMethod }
  feeLabel: string;
  funded: boolean;   // account already holds native fee juice (=> already deployed)
  azns: AZNSContract;
  zkp: Zkp;
};

export type SearchResult = {
  label: string;
  name: string;        // normalised "x.tru"
  len: number;
  tooShort: boolean;
  available: boolean;
  status: number;      // 0 available, 1 active, 2 grace
  mine: boolean;
  priceUsd: number | null;
};

let conn: Conn | null = null;
let connecting: Promise<Conn> | null = null;

const lsGet = (k: string) => globalThis.localStorage?.getItem(k) ?? null;
const lsSet = (k: string, v: string) => globalThis.localStorage?.setItem(k, v);

async function loadZkp(): Promise<Zkp> {
  const res = await fetch('/zkp_data.json');
  if (!res.ok) throw new Error('proof bundle not found');
  return (await res.json()) as Zkp;
}

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
    if (!known) throw new Error('No AZNS contract configured (set AZNS_ADDRESS in dapp/.env).');
    // Register the already-deployed AZNS instance with this PXE so we can both
    // read AND send to it (a fresh PXE doesn't know contracts it didn't deploy).
    try {
      const inst = await node.getContract(AztecAddress.fromString(known));
      if (inst) await wallet.registerContract(inst, AZNSContract.artifact);
    } catch { /* may already be registered, or sim-only works */ }
    const azns = await AZNSContract.at(AztecAddress.fromString(known), wallet);

    const zkp = await loadZkp();
    conn = { wallet, account, manager, fee, feeLabel, funded, azns, zkp };
    return conn;
  })();
  try { return await connecting; } finally { connecting = null; }
}

const sim = async (interaction: any) => (await interaction.simulate({ from: conn!.account })).result;
const send = async (interaction: any) => { await interaction.send({ from: conn!.account, fee: conn!.fee }); };

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

/** Search a label for availability + price. Read-only, fast. */
export async function search(raw: string): Promise<SearchResult> {
  await connect();
  const label = raw.normalize('NFC').trim().toLowerCase().replace(/\.tru$/, '');
  const name = normaliseName(raw);
  const len = labelLength(raw);
  if (len < 3) return { label, name, len, tooShort: true, available: false, status: -1, mine: false, priceUsd: null };
  const nh = await nameHash(raw);
  const status = Number(await sim(conn!.azns.methods.lease_status(nh)));
  const owner = toAddr(await sim(conn!.azns.methods.owner_of(nh)));
  const mine = !owner.isZero() && owner.equals(conn!.account);
  return { label, name, len, tooShort: false, available: status === 0, status, mine, priceUsd: priceCentsForLength(len) / 100 };
}

/** Register a name (deploys the account first if needed). */
export async function register(raw: string, mode: ModeName, years: number, onStep: (m: string) => void = () => {}) {
  await connect();
  await ensureWritable(onStep);
  const c = conn!;
  const nh = await nameHash(raw);
  const len = labelLength(raw);
  const modeVal = MODE[mode];
  const verified = Boolean(await sim(c.azns.methods.is_verified(c.account)));
  onStep(`Registering ${normaliseName(raw)}…`);
  if (!verified) {
    const toFr = (xs: string[]) => xs.map((x) => Fr.fromString(x));
    await send(c.azns.methods.register_first(
      nh, len, c.account, years, modeVal,
      toFr(c.zkp.vkAsFields), toFr(c.zkp.proofAsFields), toFr(c.zkp.publicInputs),
    ));
  } else {
    await send(c.azns.methods.register(nh, len, c.account, years, modeVal));
  }
  recordName(raw, mode, years);
}

// ---- "My names": tracked client-side (the chain stores hashes, not labels) ----
// The chain stores only name *hashes*, so a wallet cannot enumerate the labels
// it owns. We remember them per-browser in localStorage with enough metadata to
// show an expiry estimate. On-chain lease_status + owner_of stay the source of
// truth for status and ownership (the estimate is only for display).
const LS_NAMES = 'azns.mynames';
export type MyName = { label: string; mode: ModeName; registeredAt?: number; years?: number };

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
/** On-chain status for a name: 0 available, 1 active, 2 grace; + is it mine. */
export async function nameStatus(label: string): Promise<{ status: number; mine: boolean }> {
  await connect();
  const nh = await nameHash(label);
  const status = Number(await sim(conn!.azns.methods.lease_status(nh)));
  const owner = toAddr(await sim(conn!.azns.methods.owner_of(nh)));
  return { status, mine: !owner.isZero() && owner.equals(conn!.account) };
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

export async function setPublicTarget(raw: string, target: string, onStep: (m: string) => void = () => {}) {
  await connect(); await ensureWritable(onStep);
  const to = parseAddress(target, 'target address');
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
  const viewerAddr = parseAddress(viewer, 'viewer address');
  const targetAddr = parseAddress(target, 'target address');
  onStep('Reading the name epoch…');
  const epoch = BigInt((await sim(conn!.azns.methods.current_epoch(nh))).toString());
  const expiry = nowSecs() + ONE_YEAR_SECS; // capability valid for a year
  onStep('Granting access (private)…');
  await send(conn!.azns.methods.grant(nh, viewerAddr, targetAddr, expiry, epoch));
}

/** Revoke a viewer's resolution capability for this selective name. */
export async function revokeAccess(raw: string, viewer: string, onStep: (m: string) => void = () => {}) {
  await connect(); await ensureWritable(onStep);
  const viewerAddr = parseAddress(viewer, 'viewer address');
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

export async function renew(raw: string, years: number, onStep: (m: string) => void = () => {}) {
  await connect(); await ensureWritable(onStep);
  onStep('Renewing…');
  await send(conn!.azns.methods.renew(await nameHash(raw), labelLength(raw), years));
  recordRenewal(raw.trim().toLowerCase().replace(/\.tru$/, ''), years);
}

// =============================================================================
//  Multichain address records (ENS-style): a public name can point at an
//  address on any chain, keyed by SLIP-0044 coin type. Stored on-chain as two
//  16-byte halves + length; we encode/decode hex addresses here.
// =============================================================================
export const COIN = { AZTEC: 0xa27ecn, ETHEREUM: 60n, SOLANA: 501n, BITCOIN: 0n } as const;

function encodeAddrBytes(hex: string): { hi: bigint; lo: bigint; len: number } {
  let h = hex.trim().toLowerCase().replace(/^0x/, '');
  if (h.length % 2) h = '0' + h;
  const bytes = (h.match(/../g) ?? []).map((b) => parseInt(b, 16));
  if (bytes.length === 0 || bytes.length > 32) throw new Error('address must be 1-32 bytes (hex)');
  const buf = new Uint8Array(32);
  buf.set(bytes, 32 - bytes.length); // right-aligned
  const toBig = (a: Uint8Array) => a.reduce((acc, b) => (acc << 8n) + BigInt(b), 0n);
  return { hi: toBig(buf.slice(0, 16)), lo: toBig(buf.slice(16, 32)), len: bytes.length };
}

function decodeAddrBytes(hi: bigint, lo: bigint, len: number): string {
  if (len <= 0) return '';
  const out = new Uint8Array(32);
  const put = (v: bigint, off: number) => { for (let i = 15; i >= 0; i--) { out[off + i] = Number(v & 0xffn); v >>= 8n; } };
  put(hi, 0); put(lo, 16);
  return '0x' + [...out.slice(32 - len)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const big = (v: any): bigint => BigInt((v && v.toString) ? v.toString() : v);

/** Set the address a public name points to on a given chain (coin type). */
export async function setAddr(raw: string, coinType: bigint, hexAddr: string, onStep: (m: string) => void = () => {}) {
  await connect(); await ensureWritable(onStep);
  const { hi, lo, len } = encodeAddrBytes(hexAddr);
  onStep('Saving record…');
  await send(conn!.azns.methods.set_addr(await nameHash(raw), coinType, hi, lo, len));
}

/** Read the address a name points to on a given chain. '' if unset. */
export async function getAddr(raw: string, coinType: bigint): Promise<string> {
  await connect();
  const rec: any = await sim(conn!.azns.methods.get_addr(await nameHash(raw), coinType));
  return decodeAddrBytes(big(rec.hi), big(rec.lo), Number(big(rec.len)));
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
  return addr;
}

/** Your private token balance (null if no token configured). */
export async function tokenBalance(): Promise<bigint | null> {
  await connect();
  const addr = tokenAddress(); if (!addr) return null;
  const token = await tokenAt(addr);
  return BigInt((await sim(token.methods.balance_of_private(conn!.account))).toString());
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
const lsStealth = (name: string) => `azns.stealth.${name}`;
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
