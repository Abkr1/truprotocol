// Offline codec checks for dapp/src/chains.ts (known test vectors).
import { CHAINS, chainByKey, parseAddress, formatAddress } from '../dapp/src/chains.js';

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

async function roundtrip(chainKey: string, addr: string, expectHex?: string) {
  const chain = chainByKey(chainKey);
  const bytes = await parseAddress(chain, addr);
  const back = await formatAddress(chain, bytes);
  const norm = (s: string) => s.toLowerCase();
  if (expectHex && hex(bytes) !== expectHex) throw new Error(`${chainKey} ${addr}: bytes ${hex(bytes)} != ${expectHex}`);
  if (norm(back) !== norm(addr)) throw new Error(`${chainKey} roundtrip ${addr} -> ${back}`);
  console.log(`OK ${chainKey.padEnd(8)} ${addr} (${bytes.length}B)`);
}

async function mustFail(chainKey: string, addr: string, why: string) {
  try { await parseAddress(chainByKey(chainKey), addr); }
  catch { console.log(`OK reject  ${why}`); return; }
  throw new Error(`should have rejected: ${why}`);
}

async function main() {
  // P2PKH genesis address -> canonical scriptPubKey
  await roundtrip('BTC', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
    '76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac');
  // P2SH
  await roundtrip('BTC', '3P14159f73E4gFr7JterCCQh9QjiTjiZrG');
  // P2WPKH (BIP-173 vector; mixed-case input forbidden, all-caps allowed -> we compare lowercased)
  await roundtrip('BTC', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    '0014751e76e8199196d454941c45d1b3a323f1433bd6');
  // P2TR (BIP-86 first account address, bech32m v1)
  await roundtrip('BTC', 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');
  // EVM 20 bytes
  await roundtrip('ETH', '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2');
  await roundtrip('POLYGON', '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619');
  // Solana 32-byte base58 (wrapped SOL mint)
  await roundtrip('SOL', 'So11111111111111111111111111111111111111112');
  // Aztec
  await roundtrip('AZTEC', '0x15da61208f88da6264fb71f363783a0384d550b5b4af5823277c04821336eb09');

  await mustFail('BTC', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb', 'bad base58check checksum');
  await mustFail('BTC', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'bad bech32 checksum');
  await mustFail('ETH', '0x1234', 'short EVM address');
  await mustFail('SOL', 'abc', 'short solana key');
  console.log('\nALL CODEC CHECKS PASSED');
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
