# AZNS — Aztec Naming Service (selective-privacy)

A naming service for Aztec that does what ENS *can't*: a public, squat-proof
namespace where **resolution is private and selectively disclosable**. Three
modes per name:

| Mode | Who can resolve the name → address mapping |
|------|--------------------------------------------|
| `PUBLIC` (0) | Anyone (ENS-equivalent). Resolves to its **owner by default** the moment it's registered (no set-address step; the owner can repoint anytime). Also supports multichain address records (point a name at Ethereum/Solana/etc. addresses, ENS-style coin types). |
| `SELECTIVE` (1) | Only parties the owner explicitly grants — and each can be shown a *different* target |
| `STEALTH` (2) | Name publicly resolves to a stealth meta-key; anyone can pay, and each payment lands on a fresh, unlinkable one-time address. On-chain resolver + crypto prototype are done (`npm run stealth:demo`); the wallet-side send/scan/sweep is the remaining work — see [docs/stealth-mode.md](docs/stealth-mode.md). |

The chain only ever stores a **hash** of the label, never the cleartext name.

> **Status (testnet):** built for aztec `4.3.1`, deployed to Aztec testnet, and exercised
> end-to-end (register, resolve, multichain records). A modern search-first dApp lives in
> [`dapp/`](dapp/). See [scripts](scripts/) for `genproof`, `deploy:testnet`, `register:testnet`,
> and `stealth:demo`. Build/run notes are in this file below; the dApp points at the live
> contract via `dapp/.env`. **Unaudited — testnet only** (Aztec mainnet has a known proving
> vulnerability pending the v5 release).

**v3 adds a ZKPassport Sybil gate.** To register a name you must submit a
ZKPassport proof of personhood. The proof is verified *on-chain, natively* (same
Noir/Barretenberg/UltraHonk stack Aztec itself uses) inside the private
`register` function via `verify_honk_proof`. A per-service **nullifier** carried
in the proof's public inputs is burned so one human registers at most one name —
without the contract ever learning who that human is. We chose ZKPassport over
human.tech's Human ID because Human ID's SBTs live on Optimism (EVM/Solidity),
whereas ZKPassport verifies directly on Aztec.

---

## Architecture in one breath

Two registries fused in one contract (`azns/src/main.nr`):

- **Public existence registry** (`owners`, `expiry`, `mode`) — enforces global
  uniqueness and powers discovery. Stores commitments/hashes, not resolutions.
- **Private resolver** (`resolutions`) — encrypted UTXO notes carrying the
  name → address target, readable only by the note's recipient.

Selective disclosure = the owner mints one resolution note per authorised
viewer, each potentially pointing somewhere different.

---

## Lease & pricing (ENS-style)

Names are **rented per year, not owned forever** — same model as ENS. Annual
price is tiered by **privacy mode** (more privacy, higher price):

| Mode       | Price / year |
|------------|--------------|
| Public     | $30          |
| Selective  | $100         |
| Stealth    | $200         |

Labels under 3 characters are not sold (reserved), enforced on-chain.

How the lifecycle works:
- **Register** charges `price × years` and sets an expiry.
- **Renew** (`renew`) extends the lease without re-proving personhood — no fresh
  ZKPassport nullifier is burned, and anyone may pay to renew any name.
- **Grace period** (90 days after expiry): only the prior owner may renew; no
  one else can claim it. After grace, the name becomes freely registerable
  again (with a fresh personhood proof).
- `lease_status(name_hash)` returns 0 available / 1 active / 2 grace.

**Trustless pricing:** registration is priced by the `mode` argument — the very
value the finalizer writes to storage, so what you pay for is what you get.
Renewals happen in private where the stored mode can't be read, so `renew`
takes the mode as a *claim*: the private side charges it, and the enqueued
public step asserts it equals the stored mode — claiming a cheaper mode reverts
the whole transaction. The minimum-length rule stays tamper-proof because
`lib.ts` binds the label length *into* `name_hash` (`hash(label_bytes, length)`);
lying about length produces a hash that doesn't match the name.

**Fee settlement is a stub.** Prices are held in USD cents; `_charge` is where
you wire the actual token transfer. Two honest options, documented in the code:
(a) accept a USD-pegged stablecoin 1:1 (no oracle, simplest), or (b) accept
AZTEC/native via a price oracle (adds a trust + failure surface). No money moves
until you wire this, so the lease logic is fully testable now.

> **Personhood model (option 1, implemented):** a user proves personhood ONCE
> via `register_first` (carries the ZKPassport proof; marks their address a
> verified human). Every later name uses `register` with no proof — verified
> humans buy as many names as they want, paying each time. Letting a name lapse
> does **not** un-verify the person. When a lapsed name is taken over by someone
> new, a per-name epoch counter increments so the previous owner's selective
> grants stop resolving (stale `ResolutionNote`s no longer match the live
> epoch). `is_verified(addr)` and `current_epoch(name_hash)` expose this state.

```
aztec-naming-service/
├── README.md                  this file
├── package.json               TS deps + scripts (codegen, demo)
├── tsconfig.json              TS compiler config
├── azns/
│   ├── Nargo.toml             contract manifest — PIN THE TAG
│   └── src/
│       ├── main.nr            the contract (Sybil-gated, 3 resolution modes)
│       ├── resolution_note.nr custom private note {name_hash,target,expiry}
│       └── test.nr            native TXE tests (aztec test)
└── scripts/
    ├── lib.ts                 name normalisation + Poseidon hashing (.tru)
    ├── sponsored_fpc.ts       testnet fee-payment helper
    └── demo.ts                end-to-end sandbox demo of all 3 modes
```

**You still need to add locally** (can't be shipped here): the ZKPassport
circuit artifact + its verification key (for `vkHash` at deploy and to fill the
`PUBLIC_INPUT_COUNT` / `NULLIFIER_INDEX` placeholders in `main.nr`), obtained
from ZKPassport's `zkpassport-utils` / Aztec verifier package. Everything else
is generated by `yarn install` and `yarn codegen`.

---

## Prerequisites

```bash
# 1. Install the Aztec toolchain (Docker required)
bash -i <(curl -s https://install.aztec.network)
aztec-up                 # installs sandbox + aztec-nargo + CLI

# 2. Confirm your versions, then PIN them
aztec --version
```

> ⚠️ **Pin the version.** Open `azns/Nargo.toml` and set the `tag` on every
> dependency to the EXACT version `aztec --version` printed. Aztec.nr's macro
> and storage API changes between releases — a tag mismatch is the most common
> cause of compile failures.

---

## Build & test

```bash
# Start the local sandbox (separate terminal)
aztec start --sandbox

# Compile the contract
cd azns
aztec-nargo compile

# Fast native tests (no sandbox needed)
aztec test

# Generate the TS contract bindings
cd ..
npm install
npm run codegen

# Run the end-to-end demo against the sandbox (all 3 modes)
npm run demo
```

Expected demo output (addresses will differ):

```
[PUBLIC]    trulib.tru -> 0x<bob>          (anyone can read)
[PRIVATE]   abubakar.tru -> 0x<bob>        (only alice can read)
            public read attempt: 0x0      (privacy holds)
[SELECTIVE] trulib-corp.tru
  auditor sees: 0x<alice>   (treasury)
  bob sees    : 0x<bob>     (routing)
  -> same name, different resolution per viewer.
```

---

## What's intentionally simplified (and how to harden it)

This is a **readable testnet reference**, not a production system:

1. ✅ **Custom note type** — DONE. `src/resolution_note.nr` defines
   `ResolutionNote {name_hash, target, expiry, owner}`, so one recipient can
   hold capabilities for many names and `revoke` is precise (per-name).
2. **Ownership in private** — `grant`/`revoke` enqueue an internal public
   `_assert_grantable` to verify ownership asynchronously. Confirm the enqueue
   syntax against your installed tag.
3. **Expiry enforcement** — the note carries `expiry`, but `my_resolution`
   currently only checks it's non-zero. Tighten to compare against the chain
   timestamp (likely via an enqueued public check) once confirmed for your tag.
4. **Economics** — no fees or auctions. Add an AZTEC-token charge in
   `register()` and a premium-name auction as a phase-2 layer.
5. **Normalisation** — `scripts/lib.ts::normaliseName` must be the single
   source of truth across every client, or names will silently diverge.

---

## ⛔ Safety

- Unaudited. Do not hold real value.
- The network itself has a **known critical proving-system vulnerability**
  scheduled for the **v5 release (~July 2026)**. Build and test now; wait for
  v5 before any mainnet launch.
