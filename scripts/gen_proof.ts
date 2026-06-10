// =============================================================================
//  gen_proof.ts - generate a stand-in personhood proof for AZNS.register_first
// =============================================================================
//  Produces an UltraHonk (recursive) proof of the personhood/ circuit and
//  writes it as zkp_data.json in the shape demo.ts / the dApp expect:
//    { vkAsFields, vkHash, proofAsFields, publicInputs }
//  publicInputs is [nullifier] (the circuit's single public output).
//
//  Usage:
//    npm run genproof              # default demo secret -> zkp_data.json
//    SECRET=42 npm run genproof    # custom secret (=> a different nullifier)
//    node ... gen_proof.ts <secret> <outFile>
//
//  Each distinct secret yields a distinct nullifier, i.e. a distinct "human".
//  Swap personhood/ for the real ZKPassport circuit to use real proofs.
// =============================================================================
import { Noir } from '@aztec/noir-noir_js';
import { Barretenberg, UltraHonkBackend, deflattenFields } from '@aztec/bb.js';
import fs from 'node:fs';
import circuitJson from '../personhood/target/personhood.json' with { type: 'json' };

const secret = process.argv[2] ?? process.env.SECRET ?? '123456789';
const outFile = process.argv[3] ?? 'zkp_data.json';

async function main() {
  console.log(`generating personhood proof for secret=${secret} -> ${outFile}`);

  const bb = await Barretenberg.new({ threads: 1 });
  const circuit = new Noir(circuitJson as any);

  // Execute the circuit to obtain the witness. The public output (nullifier)
  // is derived from the secret inside the circuit.
  const { witness } = await circuit.execute({ secret });

  const backend = new UltraHonkBackend((circuitJson as any).bytecode, bb);

  // Prove + locally verify (catches errors before they hit the chain).
  const proofData = await backend.generateProof(witness, { verifierTarget: 'noir-recursive' });
  const ok = await backend.verifyProof(proofData, { verifierTarget: 'noir-recursive' });
  console.log(`local proof verification: ${ok ? 'SUCCESS' : 'FAILED'}`);
  if (!ok) throw new Error('local proof verification failed');

  // Convert proof + VK into field-element arrays for on-chain verification.
  const artifacts = await backend.generateRecursiveProofArtifacts(
    proofData.proof,
    proofData.publicInputs.length,
  );

  let proofAsFields = artifacts.proofAsFields;
  if (!proofAsFields || proofAsFields.length === 0) {
    proofAsFields = deflattenFields(proofData.proof).map((f) => f.toString());
  }

  const data = {
    vkAsFields: artifacts.vkAsFields, // 115 fields
    vkHash: artifacts.vkHash, // stored in the contract at deploy
    proofAsFields, // ~500 fields
    publicInputs: proofData.publicInputs.map((p: string) => p.toString()), // [nullifier]
  };

  console.log(`  vkAsFields:   ${data.vkAsFields.length}`);
  console.log(`  proofAsFields:${proofAsFields.length}`);
  console.log(`  publicInputs: ${data.publicInputs.length} -> nullifier=${data.publicInputs[0]}`);
  console.log(`  vkHash:       ${data.vkHash}`);

  fs.writeFileSync(outFile, JSON.stringify(data, null, 2));
  await bb.destroy();
  console.log('done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
