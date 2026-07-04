// =============================================================================
//  stealth_spike - Phase 0 feasibility spike (THROWAWAY).
// =============================================================================
//  Question: can Noir prove `p·G == P` (Grumpkin fixed-base scalar mul) in a
//  private function, and enforce a deterministic owner-only nullifier, at
//  acceptable cost? That is the ONE operation the standard token can't express
//  and the whole custom-stealth-token build hinges on it
//  (see docs/stealth-token-scope.md, and scripts/stealth_probe.ts for why the
//  standard token/account can't do sender-derived stealth).
//
//  If this compiles + the TXE tests pass, the gate is GREEN.
// =============================================================================
use aztec::macros::aztec;

#[aztec]
pub contract StealthSpike {
    use aztec::macros::{functions::{external, initializer}, storage::storage};
    use aztec::protocol::hash::poseidon2_hash;
    use aztec::state_vars::PublicImmutable;
    use std::embedded_curve_ops::{EmbeddedCurveScalar, fixed_base_scalar_mul};

    #[storage]
    struct Storage<Context> {
        version: PublicImmutable<Field, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor() {
        self.storage.version.initialize(1);
    }

    /// Spend a POINT-owned note by proving knowledge of its one-time scalar `p`
    /// (the recipient's `p = s + h`), then nullify it. In a real stealth token
    /// the note's value would move to the caller's balance here; the spike keeps
    /// only the parts that were unknown to be feasible: the in-circuit scalar
    /// mul + the point-derived nullifier.
    #[external("private")]
    fn spend(owner_x: Field, owner_y: Field, note_id: Field, p: Field) {
        // p·G  — fixed-base scalar multiplication on Grumpkin (native blackbox).
        let computed = fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(p));
        // Ownership: only someone who knows the one-time scalar can match P.
        assert((computed.x == owner_x) & (computed.y == owner_y), "not the note owner");
        // Deterministic, owner-only nullifier -> a second spend of the same note
        // (same note_id + p) reverts with "Existing nullifier".
        let nullifier = poseidon2_hash([note_id, p]);
        self.context.push_nullifier_unsafe(nullifier);
    }
}

mod test;
