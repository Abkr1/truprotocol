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
> [`dapp/`](dapp/). See [scripts](scripts/) for `deploy:testnet`, `register:testnet`,
> and `stealth:demo`. Build/run notes are in this file below; the dApp points at the live
> contract via `dapp/.env`. **Unaudited — testnet only** (Aztec mainnet has a known proving
> vulnerability pending the v5 release).

**v4 is permissionless.** Anyone can register any available name — no identity
proof, no KYC, no allowlist, no gatekeepers. The only gates are economic and
structural: per-mode annual pricing, a trustlessly-enforced minimum label
length, and the lease/grace lifecycle (an active or in-grace name can't be
taken). Squatting resistance comes from pricing, not identity.

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
| Public     | $21          |
| Selective  | $21          |
| Stealth    | $21          |

Labels are 3–31 characters; both bounds are enforced on-chain.

How the lifecycle works:
- **Register** charges `price × years` and sets an expiry.
- **Renew** (`renew`) extends the lease; anyone may pay to renew any name.
- **Grace period** (90 days after expiry): only the prior owner may renew; no
  one else can claim it. After grace, the name becomes freely registerable
  again by anyone.
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

> **Takeover safety:** when a lapsed name is taken over by someone new, a
> per-name epoch counter increments so the previous owner's selective grants
> stop resolving (stale `ResolutionNote`s no longer match the live epoch).
> `current_epoch(name_hash)` exposes this state.

```
aztec-naming-service/
├── README.md                  this file
├── package.json               TS deps + scripts (codegen, demo)
├── tsconfig.json              TS compiler config
├── azns/
│   ├── Nargo.toml             contract manifest — PIN THE TAG
│   └── src/
│       ├── main.nr            the contract (permissionless, 3 resolution modes)
│       ├── resolution_note.nr custom private note {name_hash,target,expiry}
│       └── test.nr            native TXE tests (aztec test)
└── scripts/
    ├── lib.ts                 name normalisation + Poseidon hashing (.tru)
    ├── sponsored_fpc.ts       testnet fee-payment helper
    └── demo.ts                end-to-end sandbox demo of all 3 modes
```

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
