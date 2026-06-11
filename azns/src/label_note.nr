use aztec::{
    macros::notes::note,
    protocol::traits::{Deserialize, Packable, Serialize},
};

// =============================================================================
//  LabelNote - the owner's private, on-chain backup of a name's LABEL.
// =============================================================================
//  The public registry stores only name HASHES (privacy), so without help a
//  wallet cannot list "my names" on a fresh browser/device - the labels exist
//  nowhere on-chain. At registration the contract therefore mints the owner an
//  encrypted note carrying the label bytes. Any browser holding the account's
//  keys discovers + decrypts these notes and rebuilds the dashboard; observers
//  see nothing.
//
//  The label is up to 31 ASCII bytes (MAX_LABEL_LEN) packed big-endian into a
//  single field. The contract does NOT verify the label matches name_hash -
//  it is the owner's own backup, written by their own transaction; clients
//  re-derive name_hash from the label on restore and drop anything that does
//  not check out against the public registry.
// =============================================================================

#[derive(Eq, Packable, Serialize, Deserialize)]
#[note]
pub struct LabelNote {
    pub label: Field,
}

impl LabelNote {
    pub fn new(label: Field) -> Self {
        LabelNote { label }
    }
}
