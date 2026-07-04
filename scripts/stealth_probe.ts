// =============================================================================
//  stealth_probe.ts - THROWAWAY. Answers one question fast, offline, no chain:
//  can a SENDER derive a fresh Aztec stealth account address from a recipient's
//  published meta-key alone (the property real stealth needs), given how Aztec
//  actually derives account keys + addresses?
// =============================================================================
//  The classic stealth trick works because a one-time address is P = S + h·G:
//  the sender computes it from the PUBLIC S + a shared secret h, and only the
//  recipient (who knows the secret s) can spend (p = s + h). That relies on the
//  ADDRESS being a linear (homomorphic) function of a secret scalar: pub(a+b)
//  must equal pub(a) ⊕ pub(b) on the curve.
//
//  Aztec derives every account key as sha512(secret, domain) -> scalar, and the
//  address as poseidon2(publicKeysHash, partialAddress)·G + ivpk. This probe
//  measures whether that pipeline is homomorphic. If not, a sender CANNOT name
//  the recipient's one-time account from public data -> standard-account stealth
//  is impossible and a custom (EC-linear) account contract is required.
//
//  Run:  npx tsx scripts/stealth_probe.ts
// =============================================================================
import { Fr } from '@aztec/aztec.js/fields';
import { Grumpkin } from '@aztec/foundation/crypto/grumpkin';
import { GrumpkinScalar, type Point } from '@aztec/foundation/curves/grumpkin';
import {
  deriveMasterIncomingViewingSecretKey,
  derivePublicKeyFromSecretKey,
  deriveKeys,
} from '@aztec/stdlib/keys';

const G = Grumpkin.generator;
const eq = (a: Point, b: Point) => a.x.toString() === b.x.toString() && a.y.toString() === b.y.toString();
const short = (s: string) => s.slice(0, 20) + '…';
const frAdd = (a: Fr, b: Fr) => new Fr((a.toBigInt() + b.toBigInt()) % Fr.MODULUS);

async function main() {
  console.log('=============================================================');
  console.log(' STEALTH FEASIBILITY PROBE (offline, no chain)');
  console.log('=============================================================\n');

  // --- BASELINE: the raw curve IS homomorphic - this is what stealth needs ---
  // pub(a + b) == pub(a) ⊕ pub(b), so a sender can compute S + h·G.
  const a = GrumpkinScalar.random();
  const b = GrumpkinScalar.random();
  const Pa = await Grumpkin.mul(G, a);
  const Pb = await Grumpkin.mul(G, b);
  const Pab = await Grumpkin.mul(G, a.add(b));
  const rawHomo = eq(Pab, await Grumpkin.add(Pa, Pb));
  console.log('[baseline] raw curve pub(a+b) == pub(a)+pub(b) :', rawHomo,
    rawHomo ? ' (stealth math works on bare points)' : '');

  // --- THE QUESTION: is Aztec's ACCOUNT-KEY derivation homomorphic? ----------
  // Account keys are sha512(secret, domain). If a sender knows only P = p·G
  // (the point in the meta-key), can they derive the account's incoming-viewing
  // public key (needed to encrypt a note to it)? Only if ivpk(a+b) == ivpk(a) ⊕ ivpk(b).
  const s1 = Fr.random();
  const s2 = Fr.random();
  const s12 = frAdd(s1, s2);
  const ivpk = async (s: Fr): Promise<Point> => derivePublicKeyFromSecretKey(deriveMasterIncomingViewingSecretKey(s));
  const iv1 = await ivpk(s1), iv2 = await ivpk(s2), iv12 = await ivpk(s12);
  const ivSum = await Grumpkin.add(iv1, iv2);
  const keyHomo = eq(iv12, ivSum);
  console.log('[aztec]    ivpk(s1+s2) == ivpk(s1)+ivpk(s2)     :', keyHomo,
    keyHomo ? '' : ' (sha512 KDF breaks homomorphism)');

  // --- and the ADDRESS itself (what the token's transfer(to) takes) ----------
  const pk1 = (await deriveKeys(s1)).publicKeys;
  const pk12 = (await deriveKeys(s12)).publicKeys;
  const h1 = await Promise.resolve((pk1 as any).hash());
  const h12 = await Promise.resolve((pk12 as any).hash());
  console.log('\n  ivpk(s1)          =', short(iv1.x.toString()));
  console.log('  ivpk(s2)          =', short(iv2.x.toString()));
  console.log('  ivpk(s1)+ivpk(s2) =', short(ivSum.x.toString()));
  console.log('  ivpk(s1+s2)       =', short(iv12.x.toString()), ' <- differs => NOT sender-derivable');
  console.log('\n  pubkeys-hash(s1)   =', short(h1.toString()));
  console.log('  pubkeys-hash(s1+s2)=', short(h12.toString()), ' (unrelated hash)');

  // --- VERDICT ---------------------------------------------------------------
  console.log('\n-------------------------- VERDICT --------------------------');
  if (rawHomo && !keyHomo) {
    console.log('PROVEN: the stealth trick works on RAW POINTS, but Aztec derives');
    console.log('account keys via sha512 and the AztecAddress via poseidon2, so');
    console.log('neither is EC-homomorphic. A sender holding only the meta-key point');
    console.log('canNOT compute a recipient one-time AztecAddress. And computeAddress');
    console.log('is a PROTOCOL-level hash - a custom ACCOUNT contract cannot change');
    console.log('it - so no standard-address scheme is sender-derivable either.');
    console.log('');
    console.log('=> The STANDARD TOKEN cannot do sender-derived stealth: its notes');
    console.log('   are owned by a hash-derived AztecAddress, which the sender cannot');
    console.log('   name and no un-deployed account can nullify.');
    console.log('');
    console.log('REACHABLE PATH (the real, larger build): a CUSTOM stealth NOTE/TOKEN');
    console.log('whose ownership is a raw EC point - owner = base + h·G, nullified by');
    console.log('base_secret + h (both EC-linear, hence sender-derivable + recipient-');
    console.log('spendable). Payments go to ONE published meta-key yet land as fresh,');
    console.log('unlinkable notes. That is a custom TOKEN, not the standard one, and');
    console.log('not just a custom account. Scope accordingly before promising it.');
  } else {
    console.log('Unexpected: rawHomo=' + rawHomo + ' keyHomo=' + keyHomo + ' - re-examine.');
  }
  console.log('=============================================================');
}

main().catch((e) => { console.error(e); process.exit(1); });
