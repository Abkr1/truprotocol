// TXE tests for the stealth Phase-0 spike. Proves the three gate properties:
//   1. the owner (who knows the one-time scalar p) can spend  (scalar-mul works)
//   2. someone with the WRONG scalar cannot spend             (ownership sound)
//   3. spending the same note twice fails                     (nullifier sound)
// Run: bash run_stealth_spike.sh   (aztec compile + aztec test)
use crate::StealthSpike;
use aztec::protocol::address::AztecAddress;
use aztec::test::helpers::test_environment::TestEnvironment;
use std::embedded_curve_ops::{EmbeddedCurveScalar, fixed_base_scalar_mul};

unconstrained fn deploy() -> (TestEnvironment, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let deployer = env.create_contract_account();
    let addr = env.deploy("StealthSpike").with_public_initializer(
        deployer,
        StealthSpike::interface().constructor(),
    );
    (env, addr, deployer)
}

// The one-time owner point P = p·G for a chosen scalar p, computed with the SAME
// std op the contract uses, so spend()'s recomputation matches by construction.
fn owner_point(p: Field) -> (Field, Field) {
    let pt = fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(p));
    (pt.x, pt.y)
}

#[test]
unconstrained fn owner_can_spend() {
    let (mut env, spike, caller) = deploy();
    let p: Field = 0x1234567890abcdef;
    let (px, py) = owner_point(p);
    env.call_private(caller, StealthSpike::at(spike).spend(px, py, 1, p));
    // No revert => the in-circuit p·G == P check passed and the note nullified.
}

#[test(should_fail_with = "not the note owner")]
unconstrained fn wrong_scalar_cannot_spend() {
    let (mut env, spike, caller) = deploy();
    let p: Field = 0x1234567890abcdef;
    let (px, py) = owner_point(p);
    let wrong_p: Field = 0xdeadbeef; // wrong_p·G != P
    env.call_private(caller, StealthSpike::at(spike).spend(px, py, 1, wrong_p));
}

#[test(should_fail)]
unconstrained fn double_spend_fails() {
    let (mut env, spike, caller) = deploy();
    let p: Field = 0x1234567890abcdef;
    let (px, py) = owner_point(p);
    // First spend of note 7 succeeds; the second reuses the same nullifier
    // (poseidon2([7, p])) and must revert.
    env.call_private(caller, StealthSpike::at(spike).spend(px, py, 7, p));
    env.call_private(caller, StealthSpike::at(spike).spend(px, py, 7, p));
}
