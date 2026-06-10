import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { Fr } from '@aztec/aztec.js/fields';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';

// -----------------------------------------------------------------------------
// Sponsored Fee Payment Contract (FPC) helper.
//
// Aztec transactions require fees. For sandbox/testnet, a pre-deployed
// "sponsored" FPC pays fees on your behalf so you don't need to fund accounts
// first. The fixed salt yields the same deterministic FPC address every time.
//
// In production you would replace this with a real fee payment method (native
// fee juice, or an ERC20-style FPC). See:
//   https://docs.aztec.network/developers/docs/aztec-js/how_to_pay_fees
//
// VERSION NOTE: the exact import paths (@aztec/aztec.js/contracts, /fields) and
// the SponsoredFPC artifact location track your pinned Aztec version. If an
// import fails, check the package layout for the tag in package.json.
// -----------------------------------------------------------------------------

const SPONSORED_FPC_SALT = new Fr(BigInt(0));

export async function getSponsoredFPCInstance() {
  return await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
    salt: SPONSORED_FPC_SALT,
  });
}
