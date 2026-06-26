use aztec::macros::aztec;

// =============================================================================
//  Faucet - permissionless test-token dispenser for the truProtocol demo.
// =============================================================================
//  The registry charges registration fees in a TEST token whose mint is
//  minter-gated. To make the browser flow self-serve, the operator approves
//  THIS contract as a minter of that token (token.set_minter(faucet, true)).
//  Anyone may then call claim() to mint test tokens to their own private
//  balance: the token sees the FAUCET (an approved minter) as msg_sender, while
//  the new note is created for the original caller.
//
//  TEST-ONLY. Open, uncapped minting has no place against a real stablecoin -
//  for mainnet, registrants hold the real token; there is no faucet.
// =============================================================================
#[aztec]
pub contract Faucet {
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        protocol::address::AztecAddress,
        state_vars::PublicImmutable,
    };
    use token::Token;

    #[storage]
    struct Storage<Context> {
        // The test token this faucet dispenses (set once at deploy). The operator
        // must token.set_minter(this_faucet, true) for claim() to succeed.
        token: PublicImmutable<AztecAddress, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(token: AztecAddress) {
        self.storage.token.initialize(token);
    }

    // Mint `amount` test tokens to the CALLER's private balance. Open to anyone:
    // the token's minter check passes because the minter is this faucet (the
    // token's msg_sender for the nested call), not the caller.
    #[external("private")]
    fn claim(amount: u128) {
        Token::at(self.storage.token.read())
            .mint_to_private(self.msg_sender(), amount)
            .call(self.context);
    }
}
