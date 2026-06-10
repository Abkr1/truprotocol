use aztec::{
    macros::notes::note,
    protocol::address::AztecAddress,
    protocol::traits::{Deserialize, Packable, Serialize},
};

// =============================================================================
//  ResolutionNote - custom private note for the naming-service resolver.
// =============================================================================
//  Each note is a single capability:
//  "the holder may resolve `name_hash` to `target` until `expiry`".
//
//  Carrying name_hash lets one recipient hold capabilities for MANY names and
//  filter precisely (via NoteGetterOptions.select on properties().name_hash).
//
//  #[note] auto-generates the NoteType / NoteHash / NoteProperties impls and the
//  note_type_id. #[derive(Eq, Packable, Serialize, Deserialize)] enables
//  filtering/nullification comparisons and compact packing for cheaper DA.
//
//  OWNERSHIP: notes do NOT carry an explicit owner field in this API. The
//  recipient is determined by the storage slot the note is inserted under
//  (Owned<PrivateSet<..>>.at(recipient)) and the message it is delivered to.
//  This mirrors the framework's own notes (e.g. SubscriptionNote / FieldNote).
// =============================================================================

#[derive(Eq, Packable, Serialize, Deserialize)]
#[note]
pub struct ResolutionNote {
    // The namespace entry this capability resolves.
    pub name_hash: Field,
    // What this name resolves to, FOR THIS RECIPIENT. Under MODE_SELECTIVE,
    // different recipients hold notes with different targets for the same name.
    pub target: AztecAddress,
    // Unix-seconds expiry of this capability.
    pub expiry: u64,
    // The name's registration epoch when this note was minted. If the name is
    // later taken over by a new owner (after lapse), the contract's epoch
    // increments and notes carrying the old epoch are ignored at resolve time.
    pub epoch: u64,
}

impl ResolutionNote {
    pub fn new(name_hash: Field, target: AztecAddress, expiry: u64, epoch: u64) -> Self {
        ResolutionNote { name_hash, target, expiry, epoch }
    }
}
