// Native Noir tests (TXE) - run with `aztec test` (or the run_build.sh helper).
//
// v4 made registration permissionless (no personhood proof) and PAID: register
// and renew pull the per-mode fee from the buyer via the Token contract's
// `transfer_in_private`, pre-authorized by an off-chain authwit. These tests
// deploy a real payment Token in the TXE, mint buyers their fee, build the
// authwit exactly as the dApp does (createAuthWit), and exercise the full
// register/renew lifecycle plus the takeover and input-validation guards. The
// private grant/resolve flows are exercised in scripts/demo.ts against a sandbox.
//
// PREREQUISITE: env.deploy("Token") needs the Token contract's compiled +
// AVM-transpiled artifact at azns/target/azns-Token.json. `aztec compile` only
// emits azns-AZNS.json (Token is pulled in as an interface, not a deployable
// artifact), so copy the canonical one shipped with the aztec install before
// running the suite:
//   cp .../@aztec/noir-contracts.js/artifacts/token_contract-Token.json \
//      azns/target/azns-Token.json
// (the local run_swap_token_artifact.sh + run_build_paid.sh helpers automate it.)
//
// Written for the aztec-nr v4.3.1 TXE API:
//   TestEnvironment::new(), env.create_contract_account(),
//   env.deploy(name).with_public_initializer(deployer, Iface::interface().ctor),
//   add_private_authwit_from_call(env, on_behalf_of, caller, call),
//   env.call_private / call_public / view_public with AZNS::at(addr).method(..).

use aztec::protocol::address::AztecAddress;
use aztec::protocol::hash::poseidon2_hash;
use aztec::test::helpers::authwit::add_private_authwit_from_call;
use aztec::test::helpers::test_environment::TestEnvironment;
use token::Token;
use crate::AZNS;

// The registry now binds name_hash to (label, label_len) on-chain (audit #2),
// so a valid registration must submit name_hash = poseidon2([label, len]).
// Mirrors lib.ts nameHash. Tests that expect a revert BEFORE the hash check
// (owner/length/duration/mode guards) keep passing a bogus hash on purpose.
fn nh(label: Field, label_len: u32) -> Field {
    poseidon2_hash([label, label_len as Field])
}

// Flat per-year fee in USD cents (mirrors PRICE_*_CENTS in main.nr). setup()
// deploys AZNS with unit_per_cent = 1, so the token amount equals the cents
// value: a 1-year lease costs 2100 base units. If the contract price changes,
// update this so the authwit amount stays exact.
global FEE_CENTS_PER_YEAR: u128 = 2100;

// Deploys a payment Token + an AZNS wired to charge fees in it. Returns
// (env, azns, token, treasury). `treasury` is the token admin/minter AND the
// fee sink, so tests can mint buyers exactly what a registration costs.
unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let treasury = env.create_contract_account();

    // The Token constructor takes str<31> name/symbol (padded with zeros).
    let token_init = Token::interface().constructor(
        treasury,
        "truUSD test payment token 00000",
        "TRUSD00000000000000000000000000",
        18,
    );
    let token = env.deploy("Token").with_public_initializer(treasury, token_init);

    // unit_per_cent = 1: fee_in_tokens == fee_in_cents (small, exact amounts).
    let azns_init = AZNS::interface().constructor(token, treasury, 1);
    let azns = env.deploy("AZNS").with_public_initializer(treasury, azns_init);
    (env, azns, token, treasury)
}

// Mints `payer` exactly `amount` tokens and authorizes AZNS to pull that amount
// to the treasury - the on-chain half of what the dApp does with createAuthWit.
// `fee_nonce` MUST match the nonce register()/renew() passes to
// transfer_in_private, and must be unique per charge (two charges reusing one
// nonce reuse one authwit nullifier -> the second reverts).
unconstrained fn fund_and_authorize(
    mut env: TestEnvironment,
    token: AztecAddress,
    azns: AztecAddress,
    treasury: AztecAddress,
    payer: AztecAddress,
    amount: u128,
    fee_nonce: Field,
) -> TestEnvironment {
    env.call_private(treasury, Token::at(token).mint_to_private(payer, amount));
    // The charge AZNS will make on the payer's behalf; the authwit is computed
    // over this exact call (same from/to/amount/nonce the contract uses).
    let charge = Token::at(token).transfer_in_private(payer, treasury, amount, fee_nonce);
    add_private_authwit_from_call(env, payer, azns, charge);
    env
}

// Full paid registration: fund the owner, authorize the fee, register.
unconstrained fn register_paid(
    mut env: TestEnvironment,
    token: AztecAddress,
    azns: AztecAddress,
    treasury: AztecAddress,
    owner: AztecAddress,
    name_hash: Field,
    label: Field,
    label_len: u32,
    duration_years: u64,
    mode: u8,
    fee_nonce: Field,
) -> TestEnvironment {
    let amount = FEE_CENTS_PER_YEAR * (duration_years as u128);
    env = fund_and_authorize(env, token, azns, treasury, owner, amount, fee_nonce);
    env.call_private(
        owner,
        AZNS::at(azns).register(name_hash, label, label_len, owner, duration_years, mode, fee_nonce),
    );
    env
}

// ---- read-only views on an empty registry -----------------------------------

#[test]
unconstrained fn unregistered_name_resolves_to_zero() {
    let (env, azns, _token, _treasury) = setup();
    let name = nh(0, 5);

    let resolved = env.view_public(AZNS::at(azns).resolve_public(name));
    assert(resolved.is_zero(), "unregistered name must resolve to zero");

    let owner = env.view_public(AZNS::at(azns).owner_of(name));
    assert(owner.is_zero(), "unregistered name must have zero owner");
}

#[test]
unconstrained fn unregistered_name_is_available() {
    let (env, azns, _token, _treasury) = setup();
    // lease_status: 0 = available, 1 = active, 2 = grace.
    let status = env.view_public(AZNS::at(azns).lease_status(999));
    assert(status == 0, "unregistered name must be available");
}

#[test]
unconstrained fn epoch_starts_at_zero() {
    let (env, azns, _token, _treasury) = setup();
    let epoch = env.view_public(AZNS::at(azns).current_epoch(999));
    assert(epoch == 0, "an unregistered name must have epoch 0");
}

// ---- the permissionless, PAID register lifecycle ----------------------------

// Anyone may claim an available name - no proof, no allowlist, but they DO pay
// the fee (pulled via authwit). A PUBLIC name resolves to its owner by default,
// becomes active, and bumps the epoch.
#[test]
unconstrained fn anyone_can_register() {
    let (mut env, azns, token, treasury) = setup();
    let alice = env.create_contract_account();
    let name = nh(0, 5);

    // 5-letter label, 1-year lease, MODE_PUBLIC, owner = alice.
    env = register_paid(env, token, azns, treasury, alice, name, 0, 5, 1, 0, 1);

    let owner = env.view_public(AZNS::at(azns).owner_of(name));
    assert(owner.eq(alice), "registrant must own the name");
    let resolved = env.view_public(AZNS::at(azns).resolve_public(name));
    assert(resolved.eq(alice), "public name must resolve to its owner by default");
    let status = env.view_public(AZNS::at(azns).lease_status(name));
    assert(status == 1, "freshly registered name must be active");
    let epoch = env.view_public(AZNS::at(azns).current_epoch(name));
    assert(epoch == 1, "first registration must bump the epoch to 1");
    let mode = env.view_public(AZNS::at(azns).mode_of(name));
    assert(mode == 0, "mode_of must report the registered mode");
    let expiry = env.view_public(AZNS::at(azns).expiry_of(name));
    assert(expiry > 0, "expiry_of must report a future expiry");
}

// C1 regression: two DIFFERENT names at the SAME flat price, same owner, must
// both succeed. Before the fee-nonce fix the charge used a hardcoded nonce=0,
// so the second registration reused the first's (already spent) authwit
// nullifier and reverted. Distinct fee nonces let both fee authwits coexist.
#[test]
unconstrained fn register_two_names_same_price_same_owner() {
    let (mut env, azns, token, treasury) = setup();
    let alice = env.create_contract_account();
    let name_a = nh(0xA1, 5);
    let name_b = nh(0xB2, 5);

    env = register_paid(env, token, azns, treasury, alice, name_a, 0xA1, 5, 1, 0, 1);
    env = register_paid(env, token, azns, treasury, alice, name_b, 0xB2, 5, 1, 0, 2);

    let owner_a = env.view_public(AZNS::at(azns).owner_of(name_a));
    let owner_b = env.view_public(AZNS::at(azns).owner_of(name_b));
    assert(owner_a.eq(alice), "first same-price registration must succeed");
    assert(owner_b.eq(alice), "second same-price registration must succeed (distinct fee nonce)");
}

// Registering mints the owner an encrypted label-backup note; my_labels reads
// it back so a fresh device can rebuild "my names" from chain.
#[test]
unconstrained fn label_backup_roundtrip() {
    let (mut env, azns, token, treasury) = setup();
    let alice = env.create_contract_account();
    let label = 0x7465737473; // "tests" packed big-endian
    env = register_paid(env, token, azns, treasury, alice, nh(label, 5), label, 5, 1, 0, 1);
    let labels = env.call_private(alice, AZNS::at(azns).my_labels());
    assert(labels[0] == label, "label note must round-trip via my_labels");
}

// You can only register a name to yourself - bob can't register a name with
// alice as the owner. Reverts on the owner-guard BEFORE any fee is charged, so
// no funding/authwit is needed for this case.
#[test(should_fail_with = "owner must be the caller")]
unconstrained fn cannot_register_for_someone_else() {
    let (mut env, azns, _token, _treasury) = setup();
    let alice = env.create_contract_account();
    let bob = env.create_contract_account();
    env.call_private(bob, AZNS::at(azns).register(999, 0, 5, alice, 1, 0, 1));
}

// An active name cannot be taken over. Bob pays too (his fee clears), but
// _finalize rejects the takeover of a live name.
#[test(should_fail_with = "name registered or in grace period")]
unconstrained fn active_name_cannot_be_taken() {
    let (mut env, azns, token, treasury) = setup();
    let alice = env.create_contract_account();
    let bob = env.create_contract_account();
    let name = nh(0, 5);
    env = register_paid(env, token, azns, treasury, alice, name, 0, 5, 1, 0, 1);
    env = register_paid(env, token, azns, treasury, bob, name, 0, 5, 1, 0, 2);
}

// The owner can repoint a public name anywhere, anytime (no fee on repoint).
#[test]
unconstrained fn owner_can_repoint() {
    let (mut env, azns, token, treasury) = setup();
    let alice = env.create_contract_account();
    let bob = env.create_contract_account();
    let name = nh(0, 5);
    env = register_paid(env, token, azns, treasury, alice, name, 0, 5, 1, 0, 1);
    env.call_public(alice, AZNS::at(azns).set_public_target(name, bob));
    let resolved = env.view_public(AZNS::at(azns).resolve_public(name));
    assert(resolved.eq(bob), "owner repoint must take effect");
}

// Nobody else can.
#[test(should_fail_with = "only owner")]
unconstrained fn non_owner_cannot_repoint() {
    let (mut env, azns, token, treasury) = setup();
    let alice = env.create_contract_account();
    let bob = env.create_contract_account();
    let name = nh(0, 5);
    env = register_paid(env, token, azns, treasury, alice, name, 0, 5, 1, 0, 1);
    env.call_public(bob, AZNS::at(azns).set_public_target(name, bob));
}

// P3 regression: multichain records must NOT survive a takeover. Alice sets an
// ETH record; the name lapses past grace; Bob re-registers it. The epoch bump
// moves the record slot (versioned_key), so get_addr must return empty for Bob's
// name rather than leaking Alice's address (payment-misdirection fix).
#[test]
unconstrained fn takeover_orphans_prior_records() {
    let (mut env, azns, token, treasury) = setup();
    let alice = env.create_contract_account();
    let bob = env.create_contract_account();
    let name = nh(0, 5);

    // Alice registers PUBLIC and sets an ETH (coin type 60) record.
    env = register_paid(env, token, azns, treasury, alice, name, 0, 5, 1, 0, 1);
    env.call_public(alice, AZNS::at(azns).set_addr(name, 60, 0xAA, 0xBB, 20));
    let rec = env.view_public(AZNS::at(azns).get_addr(name, 60));
    assert(rec.hi == 0xAA, "alice's record resolves while she owns the name");

    // Lapse past expiry (1yr) + grace (90d), then Bob takes it over.
    env.advance_next_block_timestamp_by(31_536_000 + 7_776_000 + 100);
    env.mine_block();
    env = register_paid(env, token, azns, treasury, bob, name, 0, 5, 1, 0, 2);

    // Alice's record must be orphaned by the epoch bump, not served to Bob.
    let stale = env.view_public(AZNS::at(azns).get_addr(name, 60));
    assert(stale.hi == 0, "prior owner's record hi must be orphaned after takeover");
    assert(stale.len == 0, "prior owner's record len must be orphaned after takeover");
}

// ---- input validation guards (all revert BEFORE the fee charge) -------------

// Leases are sold per whole year; zero years is rejected in the private call.
#[test(should_fail_with = "minimum lease is 1 year")]
unconstrained fn register_rejects_zero_duration() {
    let (mut env, azns, _token, _treasury) = setup();
    let alice = env.create_contract_account();
    env.call_private(alice, AZNS::at(azns).register(999, 0, 5, alice, 0, 0, 1));
}

// Labels under 3 characters are reserved and unpriced; register asserts.
#[test(should_fail_with = "label too short to register")]
unconstrained fn register_rejects_short_label() {
    let (mut env, azns, _token, _treasury) = setup();
    let alice = env.create_contract_account();
    env.call_private(alice, AZNS::at(azns).register(999, 0, 2, alice, 1, 0, 1));
}

// Labels are capped at 31 characters.
#[test(should_fail_with = "label too long to register")]
unconstrained fn register_rejects_long_label() {
    let (mut env, azns, _token, _treasury) = setup();
    let alice = env.create_contract_account();
    env.call_private(alice, AZNS::at(azns).register(999, 0, 32, alice, 1, 0, 1));
}

// Pricing is per mode (currently a flat $21/yr for every mode); an out-of-range
// mode is rejected by price_for_mode while computing the fee, before any charge.
#[test(should_fail_with = "invalid mode")]
unconstrained fn register_rejects_invalid_mode() {
    let (mut env, azns, _token, _treasury) = setup();
    let alice = env.create_contract_account();
    env.call_private(alice, AZNS::at(azns).register(999, 0, 5, alice, 1, 7, 1));
}

// Audit #2: name_hash is bound to (label, label_len) on-chain. Submitting a
// hash that doesn't match the claimed label+length reverts - so you can't, e.g.,
// register the reserved 1-char name's hash while declaring label_len=3. Reverts
// at the binding check, before any fee is charged.
#[test(should_fail_with = "name_hash does not match label and length")]
unconstrained fn register_rejects_mismatched_hash() {
    let (mut env, azns, _token, _treasury) = setup();
    let alice = env.create_contract_account();
    // Hash is for (label=7, len=5); we pass label=0 -> binding mismatch.
    env.call_private(alice, AZNS::at(azns).register(nh(7, 5), 0, 5, alice, 1, 0, 1));
}

// ---- renewal guards ---------------------------------------------------------

// Renewing charges the fee first, then extends. An unregistered name must fail
// in _extend_expiry's registration check - so we fund + authorize the fee to
// prove the failure is "name not registered", not an unpaid-fee revert.
#[test(should_fail_with = "name not registered")]
unconstrained fn renew_unregistered_name_fails() {
    let (mut env, azns, token, treasury) = setup();
    let alice = env.create_contract_account();
    let amount = FEE_CENTS_PER_YEAR * 1;
    env = fund_and_authorize(env, token, azns, treasury, alice, amount, 1);
    env.call_private(alice, AZNS::at(azns).renew(999, 0, 1, 1));
}

// Renewing with a lied (cheaper) mode reverts in the public mode check. Register
// as STEALTH, then renew claiming PUBLIC. The renewal uses a distinct fee nonce
// so its authwit doesn't collide with the registration's. The fee clears;
// _extend_expiry rejects the mode mismatch.
#[test(should_fail_with = "wrong mode for this name")]
unconstrained fn renew_rejects_wrong_mode() {
    let (mut env, azns, token, treasury) = setup();
    let alice = env.create_contract_account();
    let name = nh(0, 5);
    env = register_paid(env, token, azns, treasury, alice, name, 0, 5, 1, 2, 1);
    let amount = FEE_CENTS_PER_YEAR * 1;
    env = fund_and_authorize(env, token, azns, treasury, alice, amount, 2);
    env.call_private(alice, AZNS::at(azns).renew(name, 0, 1, 2));
}

// ---- audit #1 + #3: lease-gated resolution + grace-renewal ownership --------

// Audit #1: once a name lapses PAST its grace period it must resolve to zero,
// not the stale previous owner (a payer would otherwise misdirect funds).
#[test]
unconstrained fn expired_name_resolves_to_zero() {
    let (mut env, azns, token, treasury) = setup();
    let alice = env.create_contract_account();
    let name = nh(0, 5);
    env = register_paid(env, token, azns, treasury, alice, name, 0, 5, 1, 0, 1);
    let live = env.view_public(AZNS::at(azns).resolve_public(name));
    assert(live.eq(alice), "active public name resolves to its owner");

    // Advance past expiry (1yr) + grace (90d) + slack.
    env.advance_next_block_timestamp_by(31_536_000 + 7_776_000 + 100);
    env.mine_block();

    let stale = env.view_public(AZNS::at(azns).resolve_public(name));
    assert(stale.is_zero(), "past-grace name must resolve to zero, not the stale owner");
    let status = env.view_public(AZNS::at(azns).lease_status(name));
    assert(status == 0, "past-grace name must read as available");
}

// Audit #3: during GRACE, only the prior owner may renew - a third party can't
// gift-renew to keep a lapsed name bound to its abandoned owner.
#[test(should_fail_with = "only the owner may renew during grace")]
unconstrained fn grace_renewal_is_owner_only() {
    let (mut env, azns, token, treasury) = setup();
    let alice = env.create_contract_account();
    let bob = env.create_contract_account();
    let name = nh(0, 5);
    env = register_paid(env, token, azns, treasury, alice, name, 0, 5, 1, 0, 1);

    // Enter grace: just past the 1-year expiry, still within the 90-day window.
    env.advance_next_block_timestamp_by(31_536_000 + 100);
    env.mine_block();

    // Bob (not the owner) pays + authorizes, but the grace check rejects him.
    let amount = FEE_CENTS_PER_YEAR * 1;
    env = fund_and_authorize(env, token, azns, treasury, bob, amount, 2);
    env.call_private(bob, AZNS::at(azns).renew(name, 0, 1, 2));
}

// ...while the owner still can renew during grace (restores it to active). With
// the fee-nonce fix a same-price renewal works too, so this reuses the 1-year
// price with a distinct nonce from the registration.
#[test]
unconstrained fn owner_can_renew_during_grace() {
    let (mut env, azns, token, treasury) = setup();
    let alice = env.create_contract_account();
    let name = nh(0, 5);
    env = register_paid(env, token, azns, treasury, alice, name, 0, 5, 1, 0, 1);
    env.advance_next_block_timestamp_by(31_536_000 + 100);
    env.mine_block();

    let amount = FEE_CENTS_PER_YEAR * 1;
    env = fund_and_authorize(env, token, azns, treasury, alice, amount, 2);
    env.call_private(alice, AZNS::at(azns).renew(name, 0, 1, 2));
    let status = env.view_public(AZNS::at(azns).lease_status(name));
    assert(status == 1, "owner renewal during grace restores the name to active");
}
