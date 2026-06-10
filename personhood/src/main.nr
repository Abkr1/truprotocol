// =============================================================================
//  STAND-IN personhood circuit  (NOT real ZKPassport)
// =============================================================================
//  Purpose: produce a real UltraHonk proof that AZNS.register_first can verify
//  via verify_honk_proof, so the Sybil/personhood gate is fully testable on the
//  sandbox and testnet without the ZKPassport mobile app.
//
//  It proves "I know a secret" and derives a per-human NULLIFIER from that
//  secret, exposed as the circuit's single PUBLIC INPUT (the return value).
//  AZNS reads public_inputs[NULLIFIER_INDEX] (= index 0) and burns it, so:
//    - one secret  -> one nullifier -> one registration (Sybil resistance),
//    - the secret stays private (only the nullifier is public).
//
//  A real ZKPassport circuit would instead prove passport validity and derive
//  the nullifier via Poseidon over the document commitment + service scope.
//  Replacing this is a drop-in: recompile, regenerate the VK, redeploy AZNS
//  with the new vkHash, and set PUBLIC_INPUT_COUNT/NULLIFIER_INDEX to match.
// =============================================================================

fn main(secret: Field) -> pub Field {
    // Deterministic, secret-dependent nullifier. The arithmetic is only a
    // stand-in; what matters for testing is that distinct secrets yield
    // distinct nullifiers and that producing a valid proof requires the secret.
    secret * secret + secret + 1
}
