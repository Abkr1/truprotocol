import { Fr } from '@aztec/aztec.js/fields';
import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';

/**
 * Normalise a label the SAME way every client must, before hashing.
 * Mismatched normalisation = different name_hash = silent bugs.
 *  - lowercase
 *  - Unicode NFC
 *  - trim whitespace
 *  - append the ".tru" namespace if missing
 *
 * NAMESPACE: ".tru" — Trulib-branded. The suffix lives ONLY here (client-side),
 * folded into the hash; the contract never sees it. It is NOT enforced on-chain,
 * so this function must be the single shared source of truth across every
 * client (mobile, web, backend) or names will silently diverge. Changing the
 * suffix changes every resulting name_hash — treat it as immutable post-launch.
 */
export function normaliseName(raw: string): string {
  let s = raw.normalize('NFC').trim().toLowerCase();
  if (!s.endsWith('.tru')) s = `${s}.tru`;
  return s;
}

/**
 * Deterministic field hash of a normalised name. Only this hash ever
 * touches the chain — the cleartext label "abubakar.tru" never does.
 *
 * PRICING SECURITY: the label's character length is bound INTO the hash. The
 * contract charges by length (3 / 4 / 5+ letters) but only ever sees the hash,
 * so if a user declared a cheaper length than their real name, the hash they'd
 * have to submit wouldn't match the name they want. Binding length here is what
 * makes the pricing tiers tamper-proof. The contract's `label_len` argument
 * MUST equal the value used here, or registration targets a different name.
 *
 * Length counts the LABEL only (the part before ".tru"), in Unicode code
 * points — matching how a human reads the name's length.
 */
export function labelLength(raw: string): number {
  const norm = normaliseName(raw);
  const label = norm.endsWith('.tru') ? norm.slice(0, -4) : norm;
  return [...label].length; // code points, not UTF-16 units
}

export async function nameHash(raw: string): Promise<Fr> {
  const norm = normaliseName(raw);
  const len = labelLength(raw);
  // Encode UTF-8 bytes into field-sized chunks, then poseidon-hash WITH length.
  const bytes = new TextEncoder().encode(norm);
  const chunks: bigint[] = [];
  for (let i = 0; i < bytes.length; i += 31) {
    const slice = bytes.slice(i, i + 31);
    let acc = 0n;
    for (const b of slice) acc = (acc << 8n) + BigInt(b);
    chunks.push(acc);
  }
  if (chunks.length === 0) chunks.push(0n);
  // Append length as a final field so the hash commits to it.
  chunks.push(BigInt(len));
  const hashed = await poseidon2Hash(chunks.map((c) => new Fr(c)));
  return hashed;
}

export const MODE = {
  PUBLIC: 0,
  SELECTIVE: 1,
  STEALTH: 2,
} as const;
export type ModeName = keyof typeof MODE;

// Label length bounds — mirror the contract (MIN_LABEL_LEN / MAX_LABEL_LEN).
export const MIN_LABEL = 3;
export const MAX_LABEL = 31;

/** Pack a label (<=31 ASCII bytes) big-endian into one field value — the shape
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

/** Annual price in USD cents per privacy mode — mirrors the contract. */
export const PRICE_CENTS: Record<ModeName, number> = {
  PUBLIC: 2100,      // $21/yr (flat across modes)
  SELECTIVE: 2100,   // $21/yr
  STEALTH: 2100,     // $21/yr
};
export function priceCentsForMode(mode: ModeName): number {
  return PRICE_CENTS[mode];
}

export const ONE_YEAR_SECS = 365n * 24n * 60n * 60n;
