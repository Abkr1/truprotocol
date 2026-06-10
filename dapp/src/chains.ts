// =============================================================================
//  chains.ts - multichain address registry + codecs for AZNS records.
// =============================================================================
//  A name's records live on-chain as AddrRecord { hi, lo, len } keyed by a
//  SLIP-0044 / ENSIP-11 coin type. The contract treats the bytes as opaque, so
//  ALL parsing/formatting happens here:
//    - EVM chains : 20 raw bytes (0x-hex). Coin type = 0x80000000 | chainId
//                   (ENSIP-11); Ethereum mainnet keeps legacy SLIP-44 60.
//    - Bitcoin    : the scriptPubKey bytes (ENSIP-9 style), which self-describe
//                   the address kind (P2PKH/P2SH/P2WPKH/P2WSH/P2TR). Users
//                   paste a normal address (1.., 3.., bc1q.., bc1p..); we
//                   validate the checksum and store the script.
//    - Solana     : the 32-byte ed25519 pubkey (base58).
//    - Aztec      : up to 32 raw bytes (0x-hex).
//  Records can hold up to 62 bytes (two ~31-byte field-packed halves).
// =============================================================================

export type ChainKind = 'aztec' | 'evm' | 'btc' | 'sol';
export type Chain = { key: string; label: string; coinType: bigint; kind: ChainKind; placeholder: string };

const EVM = (chainId: bigint) => 0x80000000n + chainId;

export const CHAINS: Chain[] = [
  { key: 'AZTEC',    label: 'Aztec',     coinType: 0xa27ecn,   kind: 'aztec', placeholder: '0x… Aztec address' },
  { key: 'BTC',      label: 'Bitcoin',   coinType: 0n,         kind: 'btc',   placeholder: 'bc1… / 1… / 3… Bitcoin address' },
  { key: 'ETH',      label: 'Ethereum',  coinType: 60n,        kind: 'evm',   placeholder: '0x… Ethereum address' },
  { key: 'POLYGON',  label: 'Polygon',   coinType: EVM(137n),  kind: 'evm',   placeholder: '0x… Polygon address' },
  { key: 'BSC',      label: 'BNB Chain', coinType: EVM(56n),   kind: 'evm',   placeholder: '0x… BNB Chain address' },
  { key: 'ARBITRUM', label: 'Arbitrum',  coinType: EVM(42161n), kind: 'evm',  placeholder: '0x… Arbitrum address' },
  { key: 'OPTIMISM', label: 'OP Mainnet', coinType: EVM(10n),  kind: 'evm',   placeholder: '0x… OP Mainnet address' },
  { key: 'BASE',     label: 'Base',      coinType: EVM(8453n), kind: 'evm',   placeholder: '0x… Base address' },
  { key: 'SOL',      label: 'Solana',    coinType: 501n,       kind: 'sol',   placeholder: 'Solana address (base58)' },
];
export const chainByKey = (key: string): Chain => {
  const c = CHAINS.find((x) => x.key === key);
  if (!c) throw new Error(`unknown chain ${key}`);
  return c;
};

// ---- hex helpers --------------------------------------------------------------
const hexToBytes = (hex: string, what: string, exactLen?: number): Uint8Array => {
  const h = hex.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]*$/.test(h) || h.length === 0 || h.length % 2) throw new Error(`That doesn't look like a valid ${what}.`);
  const bytes = new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));
  if (exactLen !== undefined && bytes.length !== exactLen) throw new Error(`A ${what} is ${exactLen} bytes (got ${bytes.length}).`);
  return bytes;
};
const bytesToHex = (b: Uint8Array) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// ---- base58 (+check) ----------------------------------------------------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error('invalid base58 character');
    n = n * 58n + BigInt(v);
  }
  const out: number[] = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch === '1') out.unshift(0); else break; }
  return new Uint8Array(out);
}
function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
  return s;
}
const sha256 = async (b: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));

async function base58CheckDecode(s: string): Promise<{ version: number; payload: Uint8Array }> {
  const raw = base58Decode(s);
  if (raw.length < 5) throw new Error('address too short');
  const body = raw.slice(0, -4), check = raw.slice(-4);
  const digest = await sha256(await sha256(body));
  for (let i = 0; i < 4; i++) if (digest[i] !== check[i]) throw new Error('bad address checksum');
  return { version: body[0], payload: body.slice(1) };
}
async function base58CheckEncode(version: number, payload: Uint8Array): Promise<string> {
  const body = new Uint8Array([version, ...payload]);
  const digest = await sha256(await sha256(body));
  return base58Encode(new Uint8Array([...body, ...digest.slice(0, 4)]));
}

// ---- bech32 / bech32m (BIP-173 / BIP-350) -------------------------------------
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1, BECH32M_CONST = 0x2bc830a3;
function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
const hrpExpand = (hrp: string) => [...[...hrp].map((c) => c.charCodeAt(0) >>> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0, bits = 0; const out: number[] = []; const maxv = (1 << to) - 1;
  for (const v of data) {
    if (v < 0 || v >> from) throw new Error('invalid data');
    acc = (acc << from) | v; bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad) { if (bits) out.push((acc << (to - bits)) & maxv); }
  else if (bits >= from || ((acc << (to - bits)) & maxv)) throw new Error('invalid padding');
  return out;
}
function bech32Decode(addr: string): { hrp: string; version: number; program: Uint8Array } {
  const s = addr.toLowerCase();
  if (addr !== s && addr !== addr.toUpperCase()) throw new Error('mixed-case bech32');
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) throw new Error('invalid bech32 address');
  const hrp = s.slice(0, pos);
  const data = [...s.slice(pos + 1)].map((c) => B32.indexOf(c));
  if (data.includes(-1)) throw new Error('invalid bech32 character');
  const version = data[0];
  const expectConst = version === 0 ? BECH32_CONST : BECH32M_CONST;
  if (polymod([...hrpExpand(hrp), ...data]) !== expectConst) throw new Error('bad address checksum');
  const program = new Uint8Array(convertBits(data.slice(1, -6), 5, 8, false));
  if (version > 16 || program.length < 2 || program.length > 40) throw new Error('invalid witness program');
  return { hrp, version, program };
}
function bech32Encode(hrp: string, version: number, program: Uint8Array): string {
  const data = [version, ...convertBits([...program], 8, 5, true)];
  const c = version === 0 ? BECH32_CONST : BECH32M_CONST;
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ c;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data, ...checksum].map((v) => B32[v]).join('');
}

// ---- Bitcoin: address <-> scriptPubKey ----------------------------------------
async function btcAddressToScript(addr: string): Promise<Uint8Array> {
  const a = addr.trim();
  if (/^(bc1|tb1)/i.test(a)) {
    const { hrp, version, program } = bech32Decode(a);
    if (hrp !== 'bc' && hrp !== 'tb') throw new Error('not a Bitcoin bech32 address');
    if (version === 0 && program.length !== 20 && program.length !== 32) throw new Error('invalid v0 witness program');
    // scriptPubKey: OP_n <push len> <program>   (OP_0 = 0x00, OP_1..16 = 0x51..)
    const op = version === 0 ? 0x00 : 0x50 + version;
    return new Uint8Array([op, program.length, ...program]);
  }
  const { version, payload } = await base58CheckDecode(a);
  if (payload.length !== 20) throw new Error('invalid Bitcoin address payload');
  if (version === 0x00 || version === 0x6f) // P2PKH (mainnet/testnet)
    return new Uint8Array([0x76, 0xa9, 0x14, ...payload, 0x88, 0xac]);
  if (version === 0x05 || version === 0xc4) // P2SH
    return new Uint8Array([0xa9, 0x14, ...payload, 0x87]);
  throw new Error('unsupported Bitcoin address version');
}
async function btcScriptToAddress(script: Uint8Array): Promise<string> {
  const s = script;
  if (s.length === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac)
    return base58CheckEncode(0x00, s.slice(3, 23));
  if (s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87)
    return base58CheckEncode(0x05, s.slice(2, 22));
  if (s.length >= 4 && (s[0] === 0x00 || (s[0] >= 0x51 && s[0] <= 0x60)) && s[1] === s.length - 2)
    return bech32Encode('bc', s[0] === 0x00 ? 0 : s[0] - 0x50, s.slice(2));
  return bytesToHex(s) + ' (raw script)';
}

// ---- public codec --------------------------------------------------------------
/** Parse a user-pasted address for a chain into the bytes we store on-chain. */
export async function parseAddress(chain: Chain, input: string): Promise<Uint8Array> {
  const v = input.trim();
  if (!v) throw new Error('Enter an address.');
  switch (chain.kind) {
    case 'evm': return hexToBytes(v, `${chain.label} address`, 20);
    case 'aztec': {
      const b = hexToBytes(v, 'Aztec address');
      if (b.length > 32) throw new Error('Aztec addresses are at most 32 bytes.');
      return b;
    }
    case 'btc': return btcAddressToScript(v);
    case 'sol': {
      const b = base58Decode(v);
      if (b.length !== 32) throw new Error('A Solana address is a 32-byte base58 key.');
      return b;
    }
  }
}
/** Format on-chain record bytes back into a display address for a chain. */
export async function formatAddress(chain: Chain, bytes: Uint8Array): Promise<string> {
  switch (chain.kind) {
    case 'evm': return bytesToHex(bytes);
    case 'aztec': return bytesToHex(bytes);
    case 'btc': return btcScriptToAddress(bytes);
    case 'sol': return base58Encode(bytes);
  }
}
