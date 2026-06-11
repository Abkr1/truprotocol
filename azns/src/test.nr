// Native Noir tests (TXE) - run with `aztec test`.
//
// v4 made registration permissionless (no personhood proof), so the whole
// register lifecycle is testable right here: claim, default resolution,
// repoint, takeover guards, renewal guards and input validation. The private
// grant/resolve flows are exercised in scripts/demo.ts against a sandbox.
//
// Written for the aztec-nr v4.3.1 TXE API:
//   TestEnvironment::new(), env.create_light_account(),
//   env.deploy(name).with_public_initializer(deployer, Iface::interface().ctor),
//   env.call_private / call_public / view_public with AZNS::at(addr).method(..).

use aztec::protocol::address::AztecAddress;
use aztec::test::helpers::test_environment::TestEnvironment;
use crate::AZNS;

unconstrained fn setup() -> (TestEnvironment, AztecAddress) {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let init = AZNS::interface().constructor();
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
unconstrained fn epoch_starts_at_zero() {
    let (env, azns) = setup();
    let epoch = env.view_public(AZNS::at(azns).current_epoch(999));
    assert(epoch == 0, "an unregistered name must have epoch 0");
}

// ---- the permissionless register lifecycle ----------------------------------

// Anyone may claim an available name - no proof, no allowlist. A PUBLIC name
// resolves to its owner by default, becomes active, and bumps the epoch.
#[test]
unconstrained fn anyone_can_register() {
    let (mut env, azns) = setup();
    let alice = env.create_light_account();
    let name = 999;

    // 5-letter label, 1-year lease, MODE_PUBLIC, owner = alice.
    env.call_private(alice, AZNS::at(azns).register(name, 5, alice, 1, 0));

    let owner = env.view_public(AZNS::at(azns).owner_of(name));
    assert(owner.eq(alice), "registrant must own the name");
    let resolved = env.view_public(AZNS::at(azns).resolve_public(name));
    assert(resolved.eq(alice), "public name must resolve to its owner by default");
    let status = env.view_public(AZNS::at(azns).lease_status(name));
    assert(status == 1, "freshly registered name must be active");
    let epoch = env.view_public(AZNS::at(azns).current_epoch(name));
    assert(epoch == 1, "first registration must bump the epoch to 1");
}

// An active name cannot be taken over.
#[test(should_fail_with = "name registered or in grace period")]
unconstrained fn active_name_cannot_be_taken() {
    let (mut env, azns) = setup();
    let alice = env.create_light_account();
    let bob = env.create_light_account();
    let name = 999;
    env.call_private(alice, AZNS::at(azns).register(name, 5, alice, 1, 0));
    env.call_private(bob, AZNS::at(azns).register(name, 5, bob, 1, 0));
}

// The owner can repoint a public name anywhere, anytime.
#[test]
unconstrained fn owner_can_repoint() {
    let (mut env, azns) = setup();
    let alice = env.create_light_account();
    let bob = env.create_light_account();
    let name = 999;
    env.call_private(alice, AZNS::at(azns).register(name, 5, alice, 1, 0));
    env.call_public(alice, AZNS::at(azns).set_public_target(name, bob));
    let resolved = env.view_public(AZNS::at(azns).resolve_public(name));
    assert(resolved.eq(bob), "owner repoint must take effect");
}

// Nobody else can.
#[test(should_fail_with = "only owner")]
unconstrained fn non_owner_cannot_repoint() {
    let (mut env, azns) = setup();
    let alice = env.create_light_account();
    let bob = env.create_light_account();
    let name = 999;
    env.call_private(alice, AZNS::at(azns).register(name, 5, alice, 1, 0));
    env.call_public(bob, AZNS::at(azns).set_public_target(name, bob));
}

// ---- input validation guards -------------------------------------------------

// Leases are sold per whole year; zero years is rejected in the private call.
#[test(should_fail_with = "minimum lease is 1 year")]
unconstrained fn register_rejects_zero_duration() {
    let (mut env, azns) = setup();
    let alice = env.create_light_account();
    env.call_private(alice, AZNS::at(azns).register(999, 5, alice, 0, 0));
}

// Labels under 3 characters are reserved and unpriced; register asserts.
#[test(should_fail_with = "label too short to register")]
unconstrained fn register_rejects_short_label() {
    let (mut env, azns) = setup();
    let alice = env.create_light_account();
    env.call_private(alice, AZNS::at(azns).register(999, 2, alice, 1, 0));
}

// Labels are capped at 31 characters.
#[test(should_fail_with = "label too long to register")]
unconstrained fn register_rejects_long_label() {
    let (mut env, azns) = setup();
    let alice = env.create_light_account();
    env.call_private(alice, AZNS::at(azns).register(999, 32, alice, 1, 0));
}

// Pricing is per mode (PUBLIC $30 / SELECTIVE $100 / STEALTH $200 a year);
// an out-of-range mode is rejected on the charge path by price_for_mode.
#[test(should_fail_with = "invalid mode")]
unconstrained fn register_rejects_invalid_mode() {
    let (mut env, azns) = setup();
    let alice = env.create_light_account();
    env.call_private(alice, AZNS::at(azns).register(999, 5, alice, 1, 7));
}

// Renewing demands the name's REAL mode: the claimed (cheaper) mode is charged
// privately but verified against public storage in _extend_expiry. An
// unregistered name fails the registration check first.
#[test(should_fail_with = "name not registered")]
unconstrained fn renew_unregistered_name_fails() {
    let (mut env, azns) = setup();
    let alice = env.create_light_account();
    env.call_private(alice, AZNS::at(azns).renew(999, 0, 1));
}

// Renewing with a lied (cheaper) mode reverts in the public mode check.
#[test(should_fail_with = "wrong mode for this name")]
unconstrained fn renew_rejects_wrong_mode() {
    let (mut env, azns) = setup();
    let alice = env.create_light_account();
    let name = 999;
    // Register as STEALTH ($200/yr) ...
    env.call_private(alice, AZNS::at(azns).register(name, 5, alice, 1, 2));
    // ... then try to renew claiming PUBLIC ($30/yr).
    env.call_private(alice, AZNS::at(azns).renew(name, 0, 1));
}
