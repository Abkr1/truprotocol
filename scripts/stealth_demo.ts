// =============================================================================
//  stealth_demo.ts - off-chain proof of the AZNS stealth-payment crypto.
// =============================================================================
//  Validates the full loop on Aztec's native curve (Grumpkin), with no chain:
//    1. recipient publishes a meta-key (spend pub S, view pub V)
//    2. a sender derives a fresh one-time pubkey P (anyone can, from S,V)
//    3. the recipient recovers the one-time SPEND KEY p for P (only they can)
//  If p·G == P, the recipient controls the one-time address the sender paid,
//  which is the heart of stealth addresses. Run: npm run stealth:demo
// =============================================================================
import { Grumpkin } from '@aztec/foundation/crypto/grumpkin';
import { GrumpkinScalar, type Point } from '@aztec/foundation/curves/grumpkin';
import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';

const G = Grumpkin.generator;
const eq = (a: Point, b: Point) => a.x.toString() === b.x.toString() && a.y.toString() === b.y.toString();

// Hash a shared-secret point to a scalar (Poseidon2 over its coords, reduced
// into the Grumpkin scalar field).
async function pointToScalar(p: Point): Promise<GrumpkinScalar> {
  const h = await poseidon2Hash([p.x, p.y]);
  return GrumpkinScalar.fromBufferReduce(h.toBuffer());
}

async function main() {
  console.log('Grumpkin generator G =', G.x.toString().slice(0, 18), '…');

  // --- 1. Recipient one-time setup: the stealth meta-key ------------------
  const s = GrumpkinScalar.random();          // spend secret (never shared)
  const v = GrumpkinScalar.random();          // view secret  (never shared)
  const S = await Grumpkin.mul(G, s);         // spend public  ┐ published under
  const V = await Grumpkin.mul(G, v);         // view public   ┘ the .tru name
  console.log('published meta-key  S,V');

  // --- 2. A sender pays the name (only needs the public S, V) -------------
  const r = GrumpkinScalar.random();          // ephemeral secret
  const R = await Grumpkin.mul(G, r);         // ephemeral public  -> announced
  const sharedS = await Grumpkin.mul(V, r);   // ECDH: r·V
  const h = await pointToScalar(sharedS);
  const P = await Grumpkin.add(S, await Grumpkin.mul(G, h)); // one-time pub = S + h·G
  console.log('sender derived one-time address P, announces R');

  // --- 3. Recipient scans R and recovers the one-time spend key ----------
  const sharedR = await Grumpkin.mul(R, v);   // ECDH: v·R  (== r·V)
  const h2 = await pointToScalar(sharedR);
  const p = s.add(h2);                         // one-time spend secret = s + h
  const Pcheck = await Grumpkin.mul(G, p);     // should equal P

  // --- checks ------------------------------------------------------------
  const sharedOk = eq(sharedS, sharedR);
  const recoverOk = eq(P, Pcheck);
  console.log('\nECDH shared secret matches (sender == recipient):', sharedOk);
  console.log('one-time key recovered (p·G == P):               ', recoverOk);
  console.log('  P   =', P.x.toString().slice(0, 26), '…');
  console.log('  p·G =', Pcheck.x.toString().slice(0, 26), '…');

  // A second payment must land on a DIFFERENT one-time address (unlinkable).
  const r2 = GrumpkinScalar.random();
  const h2b = await pointToScalar(await Grumpkin.mul(V, r2));
  const P2 = await Grumpkin.add(S, await Grumpkin.mul(G, h2b));
  const unlinkable = !eq(P, P2);
  console.log('two payments -> different one-time addresses:    ', unlinkable);

  if (!(sharedOk && recoverOk && unlinkable)) throw new Error('STEALTH ROUND-TRIP FAILED');
  console.log('\n✅ STEALTH CRYPTO OK: anyone can pay the name; each payment lands on a fresh,');
  console.log('   unlinkable one-time address that only the recipient can spend.');
}

main().catch((e) => { console.error(e); process.exit(1); });
