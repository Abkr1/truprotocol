// Native Noir tests (TXE) - run with `aztec test`.
//
// SCOPE: v3 made registration Sybil-gated behind a ZKPassport proof, which
// can't be cheaply forged inside a pure-Noir TXE test. So the gated
// registration + private grant/resolve flows are exercised in scripts/demo.ts
// against the sandbox (with a real/standin proof bundle). Here we test the
// logic that does NOT need a valid proof:
//   - public read wiring (resolve_public / owner_of / lease_status defaults),
//   - the personhood/Sybil state defaults (is_verified / is_nullifier_spent),
//   - the input-validation and "must verify first" guards on register().
//
// Written for the aztec-nr v4.3.1 TXE API:
//   TestEnvironment::new(), env.create_light_account(),
//   env.deploy(name).with_public_initializer(deployer, Iface::interface().ctor),
//   env.call_private / call_public / view_public with AZNS::at(addr).method(..).

use aztec::protocol::address::AztecAddress;
use aztec::test::helpers::test_environment::TestEnvironment;
use crate::AZNS;

// Deploy helper: constructor takes the pinned ZKPassport VK hash. We use a
// dummy hash (0) since these tests never traverse the proof-gated path.
unconstrained fn setup() -> (TestEnvironment, AztecAddress) {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let init = AZNS::interface().constructor(0);
    let azns = env.deploy("AZNS").with_public_initializer(deployer, init);
    (env, azns)
}

#[test]
unconstrained fn unregistered_name_resolves_to_zero() {
    let (env, azns) = setup();
    let name = 999;

    let resolved = env.view_public(AZNS::at(azns).resolve_public(name));
    assert(resolved.is_zero(), "unregistered name must resolve to zero");

    let owner = env.view_public(AZNS::at(azns).owner_of(name));
    assert(owner.is_zero(), "unregistered name must have zero owner");
}

#[test]
unconstrained fn unregistered_name_is_available() {
    let (env, azns) = setup();
    // lease_status: 0 = available, 1 = active, 2 = grace.
    let status = env.view_public(AZNS::at(azns).lease_status(999));
    assert(status == 0, "unregistered name must be available");
}

#[test]
unconstrained fn fresh_nullifier_is_unspent() {
    let (env, azns) = setup();
    let spent = env.view_public(AZNS::at(azns).is_nullifier_spent(12345));
    assert(!spent, "fresh nullifier must read as unspent");
}

#[test]
unconstrained fn new_address_is_unverified() {
    let (mut env, azns) = setup();
    let alice = env.create_light_account();
    let verified = env.view_public(AZNS::at(azns).is_verified(alice));
    assert(!verified, "a brand-new address must not be a verified human");
}

#[test]
unconstrained fn epoch_starts_at_zero() {
    let (env, azns) = setup();
    let epoch = env.view_public(AZNS::at(azns).current_epoch(999));
    assert(epoch == 0, "an unregistered name must have epoch 0");
}

// ---- guard rails on register() (the no-proof, returning-user path) ----------

// A user who never proved personhood cannot register: the enqueued finalizer
// asserts the owner is already a verified human.
#[test(should_fail_with = "address not verified; use register_first")]
unconstrained fn register_requires_prior_verification() {
    let (mut env, azns) = setup();
    let alice = env.create_light_account();
    // 5-letter label (len 5), 1-year lease, MODE_PUBLIC. owner = alice.
    env.call_private(alice, AZNS::at(azns).register(999, 5, alice, 1, 0));
}

// Leases are sold per whole year; zero years is rejected in the private call.
#[test(should_fail_with = "minimum lease is 1 year")]
unconstrained fn register_rejects_zero_duration() {
    let (mut env, azns) = setup();
    let alice = env.create_light_account();
    env.call_private(alice, AZNS::at(azns).register(999, 5, alice, 0, 0));
}

// Labels under 3 characters are reserved and unpriced; price_for_length asserts.
#[test(should_fail_with = "label too short to register")]
unconstrained fn register_rejects_short_label() {
    let (mut env, azns) = setup();
    let alice = env.create_light_account();
    env.call_private(alice, AZNS::at(azns).register(999, 2, alice, 1, 0));
}
