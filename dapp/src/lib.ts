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
  const norm = normaliseName(raw);
  const len = labelLength(raw);
  const bytes = new TextEncoder().encode(norm);
  const chunks: bigint[] = [];
  for (let i = 0; i < bytes.length; i += 31) {
    const slice = bytes.slice(i, i + 31);
    let acc = 0n;
    for (const b of slice) acc = (acc << 8n) + BigInt(b);
    chunks.push(acc);
  }
  if (chunks.length === 0) chunks.push(0n);
  chunks.push(BigInt(len));
  return await poseidon2Hash(chunks.map((c) => new Fr(c)));
}

/** Annual price in USD cents for a label length - mirrors the contract. */
export function priceCentsForLength(len: number): number {
  if (len < 3) throw new Error('labels under 3 chars are not sold');
  if (len === 3) return 30000;
  if (len === 4) return 10000;
  return 1000;
}

export const MODE = { PUBLIC: 0, SELECTIVE: 1, STEALTH: 2 } as const;
export type ModeName = keyof typeof MODE;

export const ONE_YEAR_SECS = 365n * 24n * 60n * 60n;
export const nowSecs = () => BigInt(Math.floor(Date.now() / 1000));
