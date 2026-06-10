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
};

type Zkp = { vkAsFields: string[]; vkHash: string; proofAsFields: string[]; publicInputs: string[] };
type Manager = Awaited<ReturnType<EmbeddedWallet['createSchnorrAccount']>>;

type Conn = {
  wallet: EmbeddedWallet;
  account: AztecAddress;
  manager: Manager | null;
  fee: { paymentMethod: SponsoredFeePaymentMethod };
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
    const fee = { paymentMethod: new SponsoredFeePaymentMethod(fpc.address) };

    let secret = lsGet(LS.secret);
    let salt = lsGet(LS.salt);
    if (!secret || !salt) {
      secret = Fr.random().toString();
      salt = Fr.random().toString();
      lsSet(LS.secret, secret); lsSet(LS.salt, salt);
    }
    let manager: Manager | null = null;
    try { manager = await wallet.createSchnorrAccount(Fr.fromString(secret), Fr.fromString(salt)); }
    catch { manager = null; } // already registered in this PXE
    const account = (await wallet.getAccounts())[0].item;

    // A configured deployment (dapp/.env) wins over any locally-deployed address
    // left in localStorage from earlier dev sessions.
    const envAddr = process.env.AZNS_ADDRESS && process.env.AZNS_ADDRESS.length > 0 ? process.env.AZNS_ADDRESS : '';
    const known = envAddr || lsGet(LS.aznsAddress) || '';
    if (!known) throw new Error('No AZNS contract configured (set AZNS_ADDRESS in dapp/.env).');
    // Register the already-deployed AZNS instance with this PXE so we can both
    // read AND send to it (a fresh PXE doesn't know contracts it didn't deploy).
    try {
      const { createAztecNodeClient } = await import('@aztec/aztec.js/node');
      const inst = await createAztecNodeClient(NODE_URL).getContract(AztecAddress.fromString(known));
      if (inst) await wallet.registerContract(inst, AZNSContract.artifact);
    } catch { /* may already be registered, or sim-only works */ }
    const azns = await AZNSContract.at(AztecAddress.fromString(known), wallet);

    const zkp = await loadZkp();
    conn = { wallet, account, manager, fee, azns, zkp };
    return conn;
  })();
  try { return await connecting; } finally { connecting = null; }
}

const sim = async (interaction: any) => (await interaction.simulate({ from: conn!.account })).result;
const send = async (interaction: any) => { await interaction.send({ from: conn!.account, fee: conn!.fee }); };

/** Deploy the user's account on first write (sponsored). */
async function ensureWritable(onStep: (m: string) => void = () => {}): Promise<void> {
  const c = conn!;
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
  recordName(raw, mode);
}

// ---- "My names": tracked client-side (the chain stores hashes, not labels) ----
const LS_NAMES = 'azns.mynames';
export type MyName = { label: string; mode: ModeName };

export function myNames(): MyName[] {
  try { return JSON.parse(lsGet(LS_NAMES) || '[]'); } catch { return []; }
}
function recordName(raw: string, mode: ModeName) {
  const label = raw.trim().toLowerCase().replace(/\.tru$/, '');
  const list = myNames().filter((n) => n.label !== label);
  list.unshift({ label, mode });
  lsSet(LS_NAMES, JSON.stringify(list));
}
export function forgetName(label: string) {
  lsSet(LS_NAMES, JSON.stringify(myNames().filter((n) => n.label !== label)));
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

export async function setPublicTarget(raw: string, target: string, onStep: (m: string) => void = () => {}) {
  await connect(); await ensureWritable(onStep);
  onStep('Saving…');
  await send(conn!.azns.methods.set_public_target(await nameHash(raw), AztecAddress.fromString(target)));
}

export async function renew(raw: string, years: number, onStep: (m: string) => void = () => {}) {
  await connect(); await ensureWritable(onStep);
  onStep('Renewing…');
  await send(conn!.azns.methods.renew(await nameHash(raw), labelLength(raw), years));
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

/** Pay a public name with a PRIVATE transfer only (no public path => explorer-invisible). */
export async function payPrivately(raw: string, amount: bigint, onStep: (m: string) => void = () => {}) {
  await connect(); await ensureWritable(onStep);
  const addr = tokenAddress();
  if (!addr) throw new Error('No token yet — click “Get test tokens” first.');
  onStep('Resolving name…');
  const to = toAddr(await sim(conn!.azns.methods.resolve_public(await nameHash(raw))));
  if (to.isZero()) throw new Error('This name has no public address to pay.');
  onStep('Sending a private transfer…');
  const token = await tokenAt(addr);
  await send(token.methods.transfer(to, amount)); // PRIVATE transfer only
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
export const isLocal = IS_LOCAL;

export async function hardReset(): Promise<void> {
  Object.values(LS).forEach((k) => globalThis.localStorage?.removeItem(k));
  try {
    const idb: any = globalThis.indexedDB;
    if (idb?.databases) { const dbs = await idb.databases(); await Promise.all(dbs.map((d: any) => d?.name && idb.deleteDatabase(d.name))); }
  } catch { /* best effort */ }
  globalThis.location?.reload();
}
