// =============================================================================
//  Beacon - on-chain payment-discovery beacon with recipient-derivable tags
//  and payloads ENCRYPTED to the recipient's published beacon key.
// =============================================================================
//  Solves private-payment discovery WITHOUT the recipient knowing the sender:
//
//    1. The recipient publishes a beacon public key (a Grumpkin point) once,
//       via register_key(). The dApp derives it from the account secret, so
//       it follows the account across browsers.
//    2. Alongside a payment, the payer calls announce() under a tag derived
//       from that PUBLIC key (poseidon2 chain, computed with @aztec/stdlib on
//       both sides). The kernel silos the tag with this contract's address.
//    3. The payload is the payer address encrypted to the beacon key with an
//       ephemeral-ECDH one-time pad: E = e*G, S = e*K, ct = payer + H(S).
//       Only the beacon-key holder can recover the payer.
//    4. The recipient computes its own siloed tag, fetches matching logs from
//       any node (getPrivateLogsByTags - no PXE, no sender knowledge, no
//       off-chain channel), decrypts the payer, registers it as a sender, and
//       the payment note appears in its wallet.
//
//  Privacy: an observer who derives the (public) tag learns only THAT the
//  recipient received some payment - never from whom nor how much. The payer
//  address is hidden by the ECDH pad; announce() is a private function, so the
//  announcing tx reveals nothing about its caller.
//
//  Proven end-to-end on the v5 testnet by scripts/beacon_a_e2e.ts (transport)
//  - this v2 adds the key registry + encryption used by the dApp.
// =============================================================================
use aztec::macros::aztec;

#[aztec]
pub contract Beacon {
    use aztec::{
        macros::{functions::{external, view}, storage::storage},
        protocol::{
            address::AztecAddress,
            constants::PRIVATE_LOG_CIPHERTEXT_LEN,
            traits::{Deserialize, Packable, Serialize},
        },
        state_vars::{Map, PublicMutable},
    };

    // A Grumpkin point (x, y). (0, 0) means "no key published".
    #[derive(Eq, Packable, Serialize, Deserialize)]
    pub struct BeaconKey {
        pub x: Field,
        pub y: Field,
    }

    #[storage]
    struct Storage<Context> {
        keys: Map<AztecAddress, PublicMutable<BeaconKey, Context>, Context>,
    }

    /// Publish (or rotate) the caller's beacon public key. Payers read it to
    /// encrypt announce() payloads; its x/y also seed the discovery tag.
    #[external("public")]
    fn register_key(x: Field, y: Field) {
        self.storage.keys.at(self.msg_sender()).write(BeaconKey { x, y });
    }

    #[external("public")]
    #[view]
    fn key_of(owner: AztecAddress) -> BeaconKey {
        self.storage.keys.at(owner).read()
    }

    /// Emit a private log under a caller-chosen (recipient-derivable) tag.
    /// Payload: ephemeral ECDH point (e_x, e_y) + the pad-encrypted payer.
    /// Private function: the tx reveals nothing about the caller.
    ///
    /// SPAM SURFACE (audit #4, accepted trade-off): the tag is caller-chosen and
    /// a recipient's tag is derivable from their PUBLIC beacon key, so anyone can
    /// emit junk logs under a victim's tag. The victim's watcher fetches them and
    /// ECDH-fails to decrypt each (junk is discarded, and its `seen`-set means
    /// each log is processed at most once) - so it costs the spammer a tx/gas per
    /// junk log for only bounded extra client work, and payloads stay unforgeable
    /// (no valid `ct` without the payment). This is inherent to public-derivable
    /// tags; mitigations if it ever bites: a fee/PoW on announce, a per-tag cap,
    /// or watcher-side decrypt-fail backoff.
    #[external("private")]
    fn announce(tag: Field, e_x: Field, e_y: Field, ct: Field) {
        let mut log: BoundedVec<Field, PRIVATE_LOG_CIPHERTEXT_LEN> = BoundedVec::new();
        log.push(e_x);
        log.push(e_y);
        log.push(ct);
        self.context.emit_private_log_unsafe(tag, log);
    }
}
