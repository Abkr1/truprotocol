use aztec::macros::aztec;

pub mod resolution_note;
pub mod label_note;

mod test;

// =============================================================================
//  AZNS - Aztec Naming Service  - v4: permissionless registration
// =============================================================================
//  Anyone may register any available name - no identity proof, no KYC, no
//  allowlist. The only gates are economic and structural:
//    - per-mode annual pricing (see LEASE ECONOMICS),
//    - a minimum label length, enforced trustlessly via the length-bound
//      name hash,
//    - the lease/grace lifecycle (an active or in-grace name can't be taken).
//
//  Written for the aztec-nr v4.3.1 dialect:
//    #[external("private")] / #[external("public")] / #[only_self] /
//    #[contract_library_method] / self.storage / self.enqueue_self /
//    self.msg_sender() / self.context.timestamp().
// =============================================================================

#[aztec]
pub contract AZNS {
    use aztec::{
        macros::{
            functions::{external, initializer, only_self, view},
            storage::storage,
        },
        messages::delivery::MessageDelivery,
        note::{note_getter_options::NoteGetterOptions, note_interface::NoteProperties},
        protocol::{address::AztecAddress, hash::poseidon2_hash, traits::{ToField, Serialize, Deserialize, Packable}},
        state_vars::{Map, Owned, PrivateSet, PublicImmutable, PublicMutable},
        utils::comparison::Comparator,
    };
    use token::Token;
    use crate::resolution_note::ResolutionNote;
    use crate::label_note::LabelNote;

    global MODE_PUBLIC: u8 = 0;     // anyone resolves (public lookup table)
    global MODE_SELECTIVE: u8 = 1;  // only granted viewers, each a different target
    global MODE_STEALTH: u8 = 2;    // name publicly resolves to a stealth meta-key;
                                    // anyone pays, each payment to a fresh one-time address

    // A cross-chain address record (ENS-style, keyed by SLIP-0044 coin type).
    // The target address (up to 32 bytes) is split into two 16-byte halves;
    // `len` is the meaningful byte count so clients reconstruct it exactly
    // (e.g. 20 for Ethereum, 32 for Aztec/Solana). Common coin types:
    //   Aztec (custom) 0xa27ec | Ethereum 60 | Solana 501 | Bitcoin 0
    #[derive(Eq, Packable, Serialize, Deserialize)]
    pub struct AddrRecord {
        pub hi: Field,
        pub lo: Field,
        pub len: u8,
    }

    // A STEALTH meta-key: two Grumpkin public points (spend key S, view key V),
    // published openly for a stealth-mode name. Anyone can read it to pay; only
    // the owner (who holds the secrets) can find/spend the resulting payments.
    // Each point is (x, y). The one-time-address derivation happens off-chain.
    #[derive(Eq, Packable, Serialize, Deserialize)]
    pub struct StealthKey {
        pub spend_x: Field,
        pub spend_y: Field,
        pub view_x: Field,
        pub view_y: Field,
    }

    // ---- LEASE ECONOMICS ----------------------------------------------------
    // Annual price per name, by PRIVACY MODE, expressed in USD CENTS so it's an
    // integer. The contract collects in a token, so a USD->token conversion must
    // happen at the fee hook (see _charge stub). Prices (currently flat):
    //   PUBLIC    : $21/yr  (2100 cents)
    //   SELECTIVE : $21/yr  (2100 cents)
    //   STEALTH   : $21/yr  (2100 cents)
    // Names shorter than 3 chars are not sold (premium/reserved).
    global PRICE_PUBLIC_CENTS: u64 = 2100;
    global PRICE_SELECTIVE_CENTS: u64 = 2100;
    global PRICE_STEALTH_CENTS: u64 = 2100;
    global MIN_LABEL_LEN: u32 = 3;
    // Labels are 3..=31 characters. Like the minimum, the maximum is enforced
    // trustlessly: label_len is bound into name_hash off-chain (lib.ts), so
    // declaring a fake length yields a hash nobody resolves.
    global MAX_LABEL_LEN: u32 = 31;

    // Seconds in a (non-leap) year, used to convert duration_years -> seconds.
    global YEAR_SECS: u64 = 31_536_000;

    // After expiry, the previous owner keeps an exclusive renewal window before
    // anyone else can claim the name (ENS uses 90 days). During grace, only the
    // prior owner may renew; no one may register it fresh.
    global GRACE_PERIOD_SECS: u64 = 7_776_000; // 90 days

    // Returns the annual price (USD cents) for a privacy mode. Pure helper,
    // callable from any contract function (private or public). Also serves as
    // the mode-validity check on every charge path (invalid mode = revert).
    #[contract_library_method]
    fn price_for_mode(mode: u8) -> u64 {
        assert(mode <= MODE_STEALTH, "invalid mode");
        if mode == MODE_PUBLIC {
            PRICE_PUBLIC_CENTS
        } else if mode == MODE_SELECTIVE {
            PRICE_SELECTIVE_CENTS
        } else {
            PRICE_STEALTH_CENTS
        }
    }

    // Converts a USD-cent price to payment-token base units:
    //   token_amount = cents * unit_per_cent
    // Set at deploy from the payment token's decimals. For an 18-decimal
    // USD-pegged stablecoin, 1 cent = 1e16 base units, so unit_per_cent = 1e16.
    #[contract_library_method]
    fn cents_to_tokens(cents: u64, unit_per_cent: u128) -> u128 {
        (cents as u128) * unit_per_cent
    }

    // Storage key for a name's per-registration public data (stealth meta-key,
    // multichain records), scoped to the name's current epoch. Because
    // `_finalize` bumps the epoch on every (re)registration, a takeover moves
    // these reads/writes to a fresh slot, orphaning the prior owner's data -
    // the same stale-out the epoch gives selective grants. Without this, a
    // lapsed-then-retaken name would keep serving the old owner's stealth key /
    // address records (payment misdirection).
    #[contract_library_method]
    fn versioned_key(name_hash: Field, epoch: u64) -> Field {
        poseidon2_hash([name_hash, epoch as Field])
    }

    #[storage]
    struct Storage<Context> {
        // ---- FEE SETTLEMENT (set once at deploy) -------------------------
        // The token registrations/renewals are paid in, where fees go, and the
        // USD-cents -> token-units multiplier. Immutable so private functions
        // can read them when building the charge.
        payment_token: PublicImmutable<AztecAddress, Context>,
        treasury: PublicImmutable<AztecAddress, Context>,
        unit_per_cent: PublicImmutable<u128, Context>,

        // ---- PUBLIC existence registry -----------------------------------
        owners: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        expiry: Map<Field, PublicMutable<u64, Context>, Context>,
        mode: Map<Field, PublicMutable<u8, Context>, Context>,
        public_target: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        // ENS-style multichain records: versioned_key(name_hash, epoch) ->
        // coin_type -> address bytes. Keyed by the epoch-scoped slot so a
        // takeover orphans the prior owner's records.
        records: Map<Field, Map<Field, PublicMutable<AddrRecord, Context>, Context>, Context>,
        // Stealth meta-keys for stealth-mode names (public; payers read them).
        // Keyed by versioned_key(name_hash, epoch), same epoch-scoping as records.
        stealth: Map<Field, PublicMutable<StealthKey, Context>, Context>,

        // Per-name epoch. Incremented every time a name is (re)registered, so a
        // prior owner's resolution notes (minted under an older epoch) stop
        // resolving once someone else takes the name over after it lapses.
        name_epoch: Map<Field, PublicMutable<u64, Context>, Context>,

        // ---- PRIVATE resolver --------------------------------------------
        // Per-recipient note collections use Owned<PrivateSet<...>>. Usage
        // (.at(addr)) scopes the notes to that recipient's storage slot.
        resolutions: Owned<PrivateSet<ResolutionNote, Context>, Context>,
        // Encrypted per-owner label backups (see label_note.nr): lets any
        // browser/device holding the account keys rebuild "my names".
        labels: Owned<PrivateSet<LabelNote, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(payment_token: AztecAddress, treasury: AztecAddress, unit_per_cent: u128) {
        // Guard against a fee-disabling mis-deploy: unit_per_cent == 0 makes
        // every fee_amount 0, i.e. free registration/renewal.
        assert(unit_per_cent != 0, "unit_per_cent must be greater than zero");
        self.storage.payment_token.initialize(payment_token);
        self.storage.treasury.initialize(treasury);
        self.storage.unit_per_cent.initialize(unit_per_cent);
    }

    // ---- FEE-CONFIG VIEWS ---------------------------------------------------
    // So the dApp can build the EXACT authwit the charge requires - it must
    // authorize transfer_in_private(payer, treasury, fee_amount, 0) on this
    // token - without hardcoding or drifting from the deploy parameters.
    #[external("public")]
    #[view]
    fn payment_token() -> AztecAddress {
        self.storage.payment_token.read()
    }

    #[external("public")]
    #[view]
    fn treasury() -> AztecAddress {
        self.storage.treasury.read()
    }

    // The token amount register()/renew() will charge for `mode` over
    // `duration_years`. The dApp reads this and authorizes exactly it, so the
    // authwit message hash matches the contract's charge call.
    #[external("public")]
    #[view]
    fn fee_amount(mode: u8, duration_years: u64) -> u128 {
        cents_to_tokens(price_for_mode(mode) * duration_years, self.storage.unit_per_cent.read())
    }

    // =======================================================================
    //  REGISTRATION - permissionless: anyone may claim any available name.
    // =======================================================================
    //  `label` carries the raw label bytes (<= 31 ASCII chars, big-endian in
    //  one field) and is minted back to the owner as an ENCRYPTED LabelNote -
    //  their private, on-chain backup so any device with their keys can list
    //  their names. It is not validated against name_hash (it is the owner's
    //  own backup); clients re-derive name_hash from it on restore.
    #[external("private")]
    fn register(
        name_hash: Field,
        label: Field,
        label_len: u32,
        owner: AztecAddress,
        duration_years: u64,
        mode: u8,
        // Authwit nonce for the fee pull. MUST be unique per charge (the client
        // passes a fresh random value): the fee authwit's nullifier is
        // deterministic in (token-caller, from, to, amount, nonce), so a fixed
        // nonce would make two same-price registrations from one account reuse
        // one authwit -> the second reverts on the spent nullifier.
        fee_nonce: Field,
    ) {
        // You can only register a name to YOURSELF. Without this, anyone could
        // assign ownership (and a label-backup note, and - once _charge is wired
        // - the fee) to an arbitrary `owner` they don't control.
        assert(owner.eq(self.msg_sender()), "owner must be the caller");

        // Pricing is by MODE. The mode passed here is the one _finalize writes
        // to storage, so the price charged always matches the mode received -
        // there is nothing to lie about. label_len is bound into name_hash
        // off-chain (see lib.ts), so the minimum-length rule can't be dodged:
        // declaring a longer length makes name_hash not match the name being
        // claimed.
        assert(label_len >= MIN_LABEL_LEN, "label too short to register");
        assert(label_len <= MAX_LABEL_LEN, "label too long to register");
        assert(duration_years >= 1, "minimum lease is 1 year");
        let total_cents = price_for_mode(mode) * duration_years; // also validates mode
        let duration_secs = duration_years * YEAR_SECS;

        // Bind the name_hash to the claimed (label, label_len) ON-CHAIN, so the
        // min/max-length policy is trustless: a caller can't take name_hash for
        // a 1-char name while declaring label_len=3. name_hash MUST equal the
        // off-chain nameHash = poseidon2([packed_label, label_len]) (lib.ts).
        // Placed after the guards above so their errors surface first.
        assert(
            name_hash == poseidon2_hash([label, label_len as Field]),
            "name_hash does not match label and length",
        );

        // Charge the fee: pull payment tokens from the buyer into the treasury
        // (private transfer; the buyer pre-authorizes this contract via an
        // authwit off-chain - see the dApp). owner == msg_sender (asserted above).
        let amount = cents_to_tokens(total_cents, self.storage.unit_per_cent.read());
        Token::at(self.storage.payment_token.read())
            .transfer_in_private(owner, self.storage.treasury.read(), amount, fee_nonce)
            .call(self.context);

        // Private label backup for the owner (encrypted; invisible on-chain).
        self.storage.labels.at(owner).insert(LabelNote::new(label)).deliver(
            MessageDelivery::onchain_constrained(),
        );

        self.enqueue_self._finalize(name_hash, owner, duration_secs, mode);
    }

    // Read back the caller's label backups (up to 10 per call). Runs as a
    // private simulation in the caller's own wallet - nothing is revealed.
    #[external("private")]
    fn my_labels() -> [Field; 10] {
        let me = self.msg_sender();
        let options = NoteGetterOptions::new().set_limit(10);
        let notes = self.storage.labels.at(me).get_notes(options);
        let mut out: [Field; 10] = [0; 10];
        for i in 0..10 {
            if i < notes.len() {
                out[i] = notes.get(i).note.label;
            }
        }
        out
    }

    // Registration finalizer: runs the availability/grace check, bumps the
    // lease-tied note-epoch (invalidating a prior owner's stale grants), and
    // writes the registry.
    #[external("public")]
    #[only_self]
    fn _finalize(name_hash: Field, owner: AztecAddress, duration_secs: u64, mode: u8) {
        // Availability: claimable only if unowned OR fully lapsed past grace.
        // During grace the prior owner has an exclusive right to renew().
        let current_owner = self.storage.owners.at(name_hash).read();
        let now = self.context.timestamp();
        let exp = self.storage.expiry.at(name_hash).read();
        let past_grace = now > (exp + GRACE_PERIOD_SECS);
        assert(current_owner.is_zero() | past_grace, "name registered or in grace period");
        assert(mode <= MODE_STEALTH, "invalid mode");

        // Bump per-name epoch so a prior owner's selective-disclosure grants
        // (minted under the old epoch) stop resolving after a takeover.
        let new_epoch = self.storage.name_epoch.at(name_hash).read() + 1;
        self.storage.name_epoch.at(name_hash).write(new_epoch);

        self.storage.owners.at(name_hash).write(owner);
        self.storage.expiry.at(name_hash).write(now + duration_secs);
        self.storage.mode.at(name_hash).write(mode);

        // PUBLIC names resolve to their owner by default - no separate
        // set_public_target step needed (the owner can repoint anytime).
        // Non-public modes clear any stale target (e.g. takeover of a name
        // that used to be public) so nothing lingers.
        if mode == MODE_PUBLIC {
            self.storage.public_target.at(name_hash).write(owner);
        } else {
            self.storage.public_target.at(name_hash).write(AztecAddress::zero());
        }
    }

    // Current epoch for a name. Resolution notes minted under an older epoch
    // are treated as stale (used by my_resolution to ignore a prior owner's
    // grants after a takeover).
    #[external("public")]
    #[view]
    fn current_epoch(name_hash: Field) -> u64 {
        self.storage.name_epoch.at(name_hash).read()
    }

    // ---- RENEWAL ------------------------------------------------------------
    // Extends an existing lease - renewing is not a new registration. Anyone
    // may pay to
    // renew any name (ENS allows gift-renewals too). The fee uses the same
    // per-mode prices. The renewer passes the name's mode as a CLAIM (the mode
    // lives in public storage, unreadable from this private context); we charge
    // by the claim here and the enqueued public step asserts it matches the
    // stored mode - lying about a cheaper mode reverts the whole tx. Must still
    // be within the owner's control window: name exists AND (not yet expired OR
    // still inside grace period).
    #[external("private")]
    fn renew(name_hash: Field, mode: u8, duration_years: u64, fee_nonce: Field) {
        assert(duration_years >= 1, "minimum renewal is 1 year");
        let renewer = self.msg_sender(); // authenticated; forwarded to the grace check
        let annual_cents = price_for_mode(mode);
        let total_cents = annual_cents * duration_years;

        // Charge first (private pull from the renewer), then extend expiry.
        let amount = cents_to_tokens(total_cents, self.storage.unit_per_cent.read());
        Token::at(self.storage.payment_token.read())
            .transfer_in_private(renewer, self.storage.treasury.read(), amount, fee_nonce)
            .call(self.context);

        let extra_secs = duration_years * YEAR_SECS;
        self.enqueue_self._extend_expiry(name_hash, extra_secs, mode, renewer);
    }

    #[external("public")]
    #[only_self]
    fn _extend_expiry(name_hash: Field, extra_secs: u64, claimed_mode: u8, renewer: AztecAddress) {
        let current_owner = self.storage.owners.at(name_hash).read();
        assert(!current_owner.is_zero(), "name not registered");
        // The mode the renewer paid for must be the name's actual mode.
        assert(self.storage.mode.at(name_hash).read() == claimed_mode, "wrong mode for this name");

        let now = self.context.timestamp();
        let current_expiry = self.storage.expiry.at(name_hash).read();
        // Renewable while live OR within grace. Past grace, the name is gone
        // and may be freshly registered by anyone.
        let within_grace = now <= (current_expiry + GRACE_PERIOD_SECS);
        assert(within_grace, "lease lapsed past grace period; must re-register");

        // During GRACE (already expired, still renewable) only the PRIOR OWNER
        // may renew - otherwise a third party could gift-renew a lapsed name to
        // keep it bound to its abandoned owner and block re-registration after
        // grace. A LIVE name may still be gift-renewed by anyone. `renewer` is
        // the authenticated caller captured in renew(), so it can't be forged.
        if now > current_expiry {
            assert(current_owner.eq(renewer), "only the owner may renew during grace");
        }

        // Extend from the later of (now, current_expiry) so renewing early
        // doesn't burn time, and renewing during grace resumes from now.
        let base = if current_expiry > now { current_expiry } else { now };
        self.storage.expiry.at(name_hash).write(base + extra_secs);
    }

    // Lease status helper for dApps. Returns:
    //   0 = available (unregistered, or expired past grace)
    //   1 = active    (owned, not yet expired)
    //   2 = grace     (expired, but within grace; only owner may renew)
    #[external("public")]
    #[view]
    fn lease_status(name_hash: Field) -> u8 {
        let owner = self.storage.owners.at(name_hash).read();
        if owner.is_zero() {
            0
        } else {
            let now = self.context.timestamp();
            let exp = self.storage.expiry.at(name_hash).read();
            if now <= exp {
                1
            } else if now <= (exp + GRACE_PERIOD_SECS) {
                2
            } else {
                0
            }
        }
    }

    // =======================================================================
    //  PUBLIC RESOLUTION (MODE_PUBLIC)
    // =======================================================================
    #[external("public")]
    fn set_public_target(name_hash: Field, target: AztecAddress) {
        assert(self.storage.owners.at(name_hash).read().eq(self.msg_sender()), "only owner");
        assert(self.storage.mode.at(name_hash).read() == MODE_PUBLIC, "name is not in public mode");
        self.storage.public_target.at(name_hash).write(target);
    }

    // Resolution respects the lease: a name that has lapsed PAST its grace
    // period resolves to zero/empty, so payers/integrators never send to a
    // stale target for a name that is now free to register. (Active AND grace
    // names still resolve - during grace the prior owner still controls it.)
    // The check is inlined in each resolver (owner non-zero AND now <= expiry
    // + grace) so no helper-with-context is needed.
    #[external("public")]
    #[view]
    fn resolve_public(name_hash: Field) -> AztecAddress {
        let owner = self.storage.owners.at(name_hash).read();
        let exp = self.storage.expiry.at(name_hash).read();
        if (!owner.is_zero()) & (self.context.timestamp() <= (exp + GRACE_PERIOD_SECS)) {
            self.storage.public_target.at(name_hash).read()
        } else {
            AztecAddress::zero()
        }
    }

    #[external("public")]
    #[view]
    fn owner_of(name_hash: Field) -> AztecAddress {
        self.storage.owners.at(name_hash).read()
    }

    // Mode + expiry views so clients can render a name's true on-chain state
    // (dashboards must not have to trust local storage for these).
    #[external("public")]
    #[view]
    fn mode_of(name_hash: Field) -> u8 {
        self.storage.mode.at(name_hash).read()
    }

    #[external("public")]
    #[view]
    fn expiry_of(name_hash: Field) -> u64 {
        self.storage.expiry.at(name_hash).read()
    }

    // ---- MULTICHAIN ADDRESS RECORDS (ENS-style) ----------------------------
    // Point a public name at an address on any chain, keyed by coin type. The
    // name lives on Aztec; the pointer can be anywhere (Ethereum, Solana, ...).
    // Records are public-mode only (private/selective names route via grants).
    #[external("public")]
    fn set_addr(name_hash: Field, coin_type: Field, hi: Field, lo: Field, len: u8) {
        assert(self.storage.owners.at(name_hash).read().eq(self.msg_sender()), "only owner");
        assert(self.storage.mode.at(name_hash).read() == MODE_PUBLIC, "records are for public names");
        // Epoch-scoped so a takeover (which bumps the epoch) can't leave a prior
        // owner's records readable under the name (see versioned_key).
        let epoch = self.storage.name_epoch.at(name_hash).read();
        self.storage.records.at(versioned_key(name_hash, epoch)).at(coin_type).write(AddrRecord { hi, lo, len });
    }

    #[external("public")]
    #[view]
    fn get_addr(name_hash: Field, coin_type: Field) -> AddrRecord {
        let owner = self.storage.owners.at(name_hash).read();
        let exp = self.storage.expiry.at(name_hash).read();
        if (!owner.is_zero()) & (self.context.timestamp() <= (exp + GRACE_PERIOD_SECS)) {
            let epoch = self.storage.name_epoch.at(name_hash).read();
            self.storage.records.at(versioned_key(name_hash, epoch)).at(coin_type).read()
        } else {
            AddrRecord { hi: 0, lo: 0, len: 0 }
        }
    }

    // ---- STEALTH META-KEY (MODE_STEALTH) -----------------------------------
    // The owner publishes a stealth meta-key (spend + view public points).
    // NOTE: per-payment one-time-address derivation is NOT yet implemented - the
    // standard Aztec token can't support it (account keys are hash-derived, not
    // EC-homomorphic, so a sender can't derive a spendable one-time address from
    // the meta-key; see docs/stealth-mode.md). Today the key is published and
    // served, but payments route privately to the owner's account (+ beacon
    // discovery): they are private notes, not unlinkable one-time addresses.
    // The key is epoch-scoped (versioned_key) so a takeover can't serve a prior
    // owner's key.
    #[external("public")]
    fn set_stealth_meta(name_hash: Field, key: StealthKey) {
        assert(self.storage.owners.at(name_hash).read().eq(self.msg_sender()), "only owner");
        assert(self.storage.mode.at(name_hash).read() == MODE_STEALTH, "name is not stealth mode");
        let epoch = self.storage.name_epoch.at(name_hash).read();
        self.storage.stealth.at(versioned_key(name_hash, epoch)).write(key);
    }

    #[external("public")]
    #[view]
    fn resolve_stealth(name_hash: Field) -> StealthKey {
        let owner = self.storage.owners.at(name_hash).read();
        let exp = self.storage.expiry.at(name_hash).read();
        if (!owner.is_zero()) & (self.context.timestamp() <= (exp + GRACE_PERIOD_SECS)) {
            let epoch = self.storage.name_epoch.at(name_hash).read();
            self.storage.stealth.at(versioned_key(name_hash, epoch)).read()
        } else {
            StealthKey { spend_x: 0, spend_y: 0, view_x: 0, view_y: 0 }
        }
    }

    // =======================================================================
    //  SELECTIVE RESOLUTION (per-viewer grants)
    // =======================================================================
    #[external("private")]
    fn grant(
        name_hash: Field,
        recipient: AztecAddress,
        target: AztecAddress,
        expiry: u64,
        // The current registration epoch of `name_hash`, read by the client via
        // the current_epoch() view just before granting. Validated on-chain in
        // _assert_grantable so a granter can't stamp a fake epoch.
        epoch: u64,
    ) {
        let caller = self.msg_sender();
        let note = ResolutionNote::new(name_hash, target, expiry, epoch);
        // Insert the note for `recipient` and deliver it on-chain (encrypted)
        // so the recipient's PXE can discover and decrypt it.
        self.storage.resolutions.at(recipient).insert(note).deliver(
            MessageDelivery::onchain_constrained(),
        );
        self.enqueue_self._assert_grantable(name_hash, caller, epoch);
    }

    #[external("public")]
    #[only_self]
    fn _assert_grantable(name_hash: Field, claimed_owner: AztecAddress, claimed_epoch: u64) {
        assert(
            self.storage.owners.at(name_hash).read().eq(claimed_owner),
            "granter does not own this name",
        );
        assert(
            self.storage.mode.at(name_hash).read() == MODE_SELECTIVE,
            "grants are only for selective names",
        );
        // The epoch stamped into the note must be the name's CURRENT epoch, so
        // a granter can't pre-mint notes under a future/old epoch.
        assert(self.storage.name_epoch.at(name_hash).read() == claimed_epoch, "stale or wrong epoch");
    }

    // Resolve a name the caller holds a capability for. `current_epoch` is read
    // by the client from current_epoch(name_hash) immediately before calling;
    // a note minted under a previous owner (older epoch) won't match, so a
    // lapsed-and-retaken name's stale grants silently resolve to nothing.
    #[external("private")]
    fn my_resolution(name_hash: Field, current_epoch: u64) -> Field {
        let me = self.msg_sender();
        let options = NoteGetterOptions::new()
            .select(ResolutionNote::properties().name_hash, Comparator.EQ, name_hash)
            .select(ResolutionNote::properties().epoch, Comparator.EQ, current_epoch as Field)
            .set_limit(1);
        let notes = self.storage.resolutions.at(me).get_notes(options);
        let mut out: Field = 0;
        if notes.len() != 0 {
            let n = notes.get(0).note;
            if (n.expiry as Field) != 0 {
                out = n.target.to_field();
            }
        }
        out
    }

    // NOTE: there is deliberately no on-demand `revoke`. A grant is an encrypted
    // note already in the recipient's wallet - once delivered, no on-chain action
    // can nullify a note the contract owner cannot produce a nullifier for, and
    // the recipient has already decrypted the target regardless. Grants are
    // therefore effective for the life of the name; only a takeover after the
    // lease fully lapses (which bumps name_epoch) invalidates outstanding grants.
    // Share selective access deliberately.
}

// =============================================================================
//  OPEN ITEMS before this is production-ready:
//   - The fee is now charged for real: register()/renew() pull the per-mode
//     price from the buyer via Token::transfer_in_private, authorized by an
//     off-chain authwit (verified end-to-end in src/test.nr against a TXE-
//     deployed Token). The dApp must build that authwit (wallet.createAuthWit)
//     on register/renew, and a real USD-pegged stablecoin + treasury +
//     unit_per_cent must be passed to the constructor at mainnet deploy.
//   - Unaudited. Do not deploy to mainnet without a security audit.
// =============================================================================
