use aztec::macros::aztec;

pub mod resolution_note;

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
        messages::message_delivery::MessageDelivery,
        note::{note_getter_options::NoteGetterOptions, note_interface::NoteProperties},
        protocol::{address::AztecAddress, traits::{ToField, Serialize, Deserialize, Packable}},
        state_vars::{Map, Owned, PrivateSet, PublicMutable},
        utils::comparison::Comparator,
    };
    use crate::resolution_note::ResolutionNote;

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
    // happen at the fee hook (see _charge stub). Prices:
    //   PUBLIC    : $10/yr   ( 1000 cents)
    //   SELECTIVE : $50/yr   ( 5000 cents)
    //   STEALTH   : $100/yr  (10000 cents)
    // Names shorter than 3 chars are not sold (premium/reserved).
    global PRICE_PUBLIC_CENTS: u64 = 1000;
    global PRICE_SELECTIVE_CENTS: u64 = 5000;
    global PRICE_STEALTH_CENTS: u64 = 10000;
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

    // ---- FEE CHARGE (STUB) --------------------------------------------------
    // Collects `amount_cents` (USD) worth of payment from `payer`. This is a
    // STUB: wire it to your chosen settlement asset. Two honest options:
    //   (a) Stablecoin-denominated: hold prices in USD cents and accept a
    //       USD-pegged token 1:1 (simplest, no oracle).
    //   (b) AZTEC/native: convert cents->token via a price oracle, then pull
    //       the token. Needs a trusted price feed.
    // Until wired, this asserts the amount is sane and returns; NO MONEY MOVES,
    // so the lease logic is fully testable without the payment rail.
    #[contract_library_method]
    fn _charge(payer: AztecAddress, amount_cents: u64) {
        let _ = payer;
        assert(amount_cents > 0, "zero fee");
        // TODO: token transfer of `amount_cents` (or its token equivalent)
        // from `payer` into the contract treasury. See options (a)/(b) above.
    }

    #[storage]
    struct Storage<Context> {
        // ---- PUBLIC existence registry -----------------------------------
        owners: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        expiry: Map<Field, PublicMutable<u64, Context>, Context>,
        mode: Map<Field, PublicMutable<u8, Context>, Context>,
        public_target: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        // ENS-style multichain records: name_hash -> coin_type -> address bytes.
        records: Map<Field, Map<Field, PublicMutable<AddrRecord, Context>, Context>, Context>,
        // Stealth meta-keys for stealth-mode names (public; payers read them).
        stealth: Map<Field, PublicMutable<StealthKey, Context>, Context>,

        // Per-name epoch. Incremented every time a name is (re)registered, so a
        // prior owner's resolution notes (minted under an older epoch) stop
        // resolving once someone else takes the name over after it lapses.
        name_epoch: Map<Field, PublicMutable<u64, Context>, Context>,

        // ---- PRIVATE resolver --------------------------------------------
        // Per-recipient note collections use Owned<PrivateSet<...>>. Usage
        // (.at(addr)) scopes the notes to that recipient's storage slot.
        resolutions: Owned<PrivateSet<ResolutionNote, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor() {}

    // =======================================================================
    //  REGISTRATION - permissionless: anyone may claim any available name.
    // =======================================================================
    #[external("private")]
    fn register(name_hash: Field, label_len: u32, owner: AztecAddress, duration_years: u64, mode: u8) {
        // Pricing is by MODE. The mode passed here is the one _finalize writes
        // to storage, so the price charged always matches the mode received -
        // there is nothing to lie about. label_len is bound into name_hash
        // off-chain (see lib.ts), so the minimum-length rule can't be dodged:
        // declaring a longer length makes name_hash not match the name being
        // claimed.
        assert(label_len >= MIN_LABEL_LEN, "label too short to register");
        assert(label_len <= MAX_LABEL_LEN, "label too long to register");
        assert(duration_years >= 1, "minimum lease is 1 year");
        let total_cents = price_for_mode(mode) * duration_years;
        let duration_secs = duration_years * YEAR_SECS;
        _charge(owner, total_cents);

        self.enqueue_self._finalize(name_hash, owner, duration_secs, mode);
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
    fn renew(name_hash: Field, mode: u8, duration_years: u64) {
        assert(duration_years >= 1, "minimum renewal is 1 year");
        let annual_cents = price_for_mode(mode);
        let total_cents = annual_cents * duration_years;

        // Charge first (private), then extend expiry (public).
        _charge(self.msg_sender(), total_cents);

        let extra_secs = duration_years * YEAR_SECS;
        self.enqueue_self._extend_expiry(name_hash, extra_secs, mode);
    }

    #[external("public")]
    #[only_self]
    fn _extend_expiry(name_hash: Field, extra_secs: u64, claimed_mode: u8) {
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

    #[external("public")]
    #[view]
    fn resolve_public(name_hash: Field) -> AztecAddress {
        self.storage.public_target.at(name_hash).read()
    }

    #[external("public")]
    #[view]
    fn owner_of(name_hash: Field) -> AztecAddress {
        self.storage.owners.at(name_hash).read()
    }

    // ---- MULTICHAIN ADDRESS RECORDS (ENS-style) ----------------------------
    // Point a public name at an address on any chain, keyed by coin type. The
    // name lives on Aztec; the pointer can be anywhere (Ethereum, Solana, ...).
    // Records are public-mode only (private/selective names route via grants).
    #[external("public")]
    fn set_addr(name_hash: Field, coin_type: Field, hi: Field, lo: Field, len: u8) {
        assert(self.storage.owners.at(name_hash).read().eq(self.msg_sender()), "only owner");
        assert(self.storage.mode.at(name_hash).read() == MODE_PUBLIC, "records are for public names");
        self.storage.records.at(name_hash).at(coin_type).write(AddrRecord { hi, lo, len });
    }

    #[external("public")]
    #[view]
    fn get_addr(name_hash: Field, coin_type: Field) -> AddrRecord {
        self.storage.records.at(name_hash).at(coin_type).read()
    }

    // ---- STEALTH META-KEY (MODE_STEALTH) -----------------------------------
    // The owner publishes a stealth meta-key (spend + view public points).
    // Anyone can read it and pay the name; the wallet derives a fresh one-time
    // address per payment (off-chain), so every payment is unlinkable and the
    // owner's real address is never exposed. The contract just stores/serves it.
    #[external("public")]
    fn set_stealth_meta(name_hash: Field, key: StealthKey) {
        assert(self.storage.owners.at(name_hash).read().eq(self.msg_sender()), "only owner");
        assert(self.storage.mode.at(name_hash).read() == MODE_STEALTH, "name is not stealth mode");
        self.storage.stealth.at(name_hash).write(key);
    }

    #[external("public")]
    #[view]
    fn resolve_stealth(name_hash: Field) -> StealthKey {
        self.storage.stealth.at(name_hash).read()
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
            MessageDelivery.ONCHAIN_CONSTRAINED,
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

    #[external("private")]
    fn revoke(name_hash: Field, recipient: AztecAddress) {
        let caller = self.msg_sender();
        let options = NoteGetterOptions::new().select(
            ResolutionNote::properties().name_hash,
            Comparator.EQ,
            name_hash,
        );
        let _ = self.storage.resolutions.at(recipient).pop_notes(options);
        self.enqueue_self._assert_owner_only(name_hash, caller);
    }

    // Owner check without epoch (revoke nullifies existing notes; it doesn't
    // mint new ones, so there's no epoch to validate).
    #[external("public")]
    #[only_self]
    fn _assert_owner_only(name_hash: Field, claimed_owner: AztecAddress) {
        assert(
            self.storage.owners.at(name_hash).read().eq(claimed_owner),
            "granter does not own this name",
        );
    }
}

// =============================================================================
//  OPEN ITEMS before this is production-ready (compiles + tests as-is):
//   1. _charge is a stub - wire the real token settlement. Until then,
//      registration is free in practice, so the per-mode pricing is not yet
//      an effective anti-squatting deterrent.
// =============================================================================
