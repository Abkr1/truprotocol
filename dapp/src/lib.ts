// Name normalisation + length-bound Poseidon hashing for AZNS.
// MUST stay byte-for-byte identical to scripts/lib.ts (the single source of
// truth) or names will diverge between clients.
import { Fr } from '@aztec/aztec.js/fields';
import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';

/** lowercase + NFC + trim + append ".tru" namespace if missing. */
export function normaliseName(raw: string): string {
  let s = raw.normalize('NFC').trim().toLowerCase();
  if (!s.endsWith('.tru')) s = `${s}.tru`;
  return s;
}

/** Label length (code points of the part before ".tru"). Bound into the hash. */
export function labelLength(raw: string): number {
  const norm = normaliseName(raw);
  const label = norm.endsWith('.tru') ? norm.slice(0, -4) : norm;
  return [...label].length;
}

/** Deterministic length-bound Poseidon hash of a normalised name. */
export async function nameHash(raw: string): Promise<Fr> {
  // name_hash = poseidon2([packed_label, label_len]) — the CONTRACT recomputes
  // this on-chain in register() and rejects a mismatch, enforcing the length
  // policy trustlessly (audit #2). MUST match Noir poseidon2_hash([label,len])
  // and scripts/lib.ts. packLabel throws for labels >31 bytes.
  const packed = packLabel(raw);
  const len = labelLength(raw);
  return await poseidon2Hash([new Fr(packed), new Fr(BigInt(len))]);
}

export const MODE = { PUBLIC: 0, SELECTIVE: 1, STEALTH: 2 } as const;
export type ModeName = keyof typeof MODE;

// Label length bounds - mirror the contract (MIN_LABEL_LEN / MAX_LABEL_LEN).
export const MIN_LABEL = 3;
export const MAX_LABEL = 31;

/** Pack a label (<=31 ASCII bytes) big-endian into one field value - the shape
 *  the contract stores in the owner's encrypted LabelNote backup. */
export function packLabel(raw: string): bigint {
  const label = normaliseName(raw).replace(/\.tru$/, '');
  const bytes = new TextEncoder().encode(label);
  if (bytes.length === 0 || bytes.length > 31) throw new Error('label must be 1-31 bytes');
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) + BigInt(b);
  return acc;
}

/** Reverse of packLabel. Returns '' for zero/undecodable values. */
export function unpackLabel(v: bigint): string {
  if (v <= 0n) return '';
  const bytes: number[] = [];
  let x = v;
  while (x > 0n) { bytes.unshift(Number(x & 0xffn)); x >>= 8n; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)); }
  catch { return ''; }
}

/** Annual price in USD cents per privacy mode - mirrors the contract. */
export const PRICE_CENTS: Record<ModeName, number> = {
  PUBLIC: 2100,      // $21/yr (flat across modes)
  SELECTIVE: 2100,   // $21/yr
  STEALTH: 2100,     // $21/yr
};
export const priceUsdForMode = (mode: ModeName): number => PRICE_CENTS[mode] / 100;

export const ONE_YEAR_SECS = 365n * 24n * 60n * 60n;
export const nowSecs = () => BigInt(Math.floor(Date.now() / 1000));
