# truProtocol — private `.tru` names on Aztec

A naming service for Aztec that does what ENS *can't*: a public, squat-proof
namespace where **resolution is private and selectively disclosable**, payments
to names are **invisible on-chain**, and incoming payments **discover
themselves** without the recipient ever learning who to look for. Three modes
per name:

| Mode | Who can resolve the name → address mapping |
|------|--------------------------------------------|
| `PUBLIC` (0) | Anyone (ENS-equivalent). Resolves to its **owner by default** the moment it's registered (no set-address step; repoint anytime). Supports multichain address records (Ethereum/Bitcoin/Solana/… via SLIP-0044 coin types). |
| `SELECTIVE` (1) | Only parties the owner explicitly grants — and each can be shown a *different* target. |
| `STEALTH` (2) | The name publicly resolves to a stealth meta-key; anyone can pay, each payment lands on a fresh, unlinkable one-time address. The dApp auto-publishes the meta-key at registration. |

The chain only ever stores a **hash** of the label, never the cleartext name.
In every mode, payments themselves are private — no sender, recipient, or
amount ever appears on-chain.

> **Status:** built on aztec **`5.0.0-nightly.20260701`** (the AZUP-2 / v5
> protocol line), deployed to the public v5 testnet, and exercised end-to-end
> **in a real browser**: self-serve tokens → paid registration → private
> payment → autonomous payment discovery. One **external security review** has
> been completed and **all 5 findings fixed + verified** (19 TXE tests + a live
> fee/hash cross-check) — see [Safety](#safety). Live registry (testnet):
> `0x2642636e7b6c199b7617d6ea987fe2de3775ec0c98f646dc3b0b4c223f2aa08a`.
> **Still testnet-only; a full audit remains a hard gate before mainnet.**

---

## What's built

### Contracts (Noir / aztec-nr)

| Contract | Purpose |
|---|---|
| [`azns/`](azns/) | The registry. Permissionless, charged registration/renewal (the contract pulls the per-mode fee from the buyer's token balance via an authwit'd `transfer_in_private`), public existence registry + private resolver notes, per-name epochs (takeover safety), multichain address records, stealth meta-keys, and encrypted on-chain **label backups** so "My names" follows the account to any device. 15 TXE tests. |
| [`faucet/`](faucet/) | Open-mint test-token faucet (approved as a token minter) so any fresh browser account can self-serve tokens and exercise the paid flow. Test-net only. |
| [`beacon/`](beacon/) | **Payment discovery.** Recipients publish a beacon key (`register_key`); payers `announce()` each payment under a tag derived from that public key, with the **payer identity ECDH-encrypted** in the payload. The kernel silos the caller-chosen tag; recipients recompute their own tag and fetch matching logs straight from any node. |

### The payment-discovery problem (and its solution)

On Aztec, a wallet only finds incoming private notes from senders it has
**registered** — so a payment from a stranger is invisible until you learn who
paid you. Both known escape hatches were built and proven live on testnet:

- **Option A — on-chain beacon** (shipped in the dApp): no off-chain
  infrastructure, chain-only. An observer who derives the (public) tag learns
  only *that* a payment arrived — never from whom nor how much.
  [`scripts/beacon_a_e2e.ts`](scripts/beacon_a_e2e.ts)
- **Option B — off-chain relay** (reference implementation): payer posts an
  encrypted hint to a relay the recipient polls.
  [`scripts/relay_b_e2e.ts`](scripts/relay_b_e2e.ts)
- The shared primitive (registerSender reveals *historical* notes) is proven in
  [`scripts/discovery_e2e.ts`](scripts/discovery_e2e.ts), and the full dApp
  loop (unknown payer → autonomous discovery in the browser) in
  [`scripts/pay_browser_e2e.ts`](scripts/pay_browser_e2e.ts).

### dApp ([`dapp/`](dapp/))

Search-first React app (vite, production build served via `vite preview`):

- **Search / register / renew / repoint / multichain records**, with per-mode
  pricing pulled from the chain and friendly balance checks before paid calls.
- **Private payments to names or raw addresses** — private transfer only (no
  public path exists in the UI), with an automatic beacon `announce` so the
  recipient's wallet discovers the payment by itself. Incoming payments surface
  as a "Payment received" toast with zero user action (the watcher scans the
  beacon tag, decrypts the payer, registers the sender, and the balance
  updates).
- **Two wallet modes:**
  - *Embedded (default):* a self-custodied per-browser account (secret in
    localStorage, **no house key in the bundle**), deployed lazily on first
    write via the sponsored FPC, with a one-time checkpoint wait so the first
    transaction never races note sync.
  - *External — Azguard:* a full bring-your-own-keys path over
    `@azguardwallet/client` (dependency-free, **version-neutral** inpage RPC —
    no second `aztec.js` in the bundle). When connected: identity, private
    balances, and label restore follow the external account; register/renew
    ship the fee authwit atomically with the call; pay+announce batch into
    **one** wallet transaction; discovered payers are registered in the wallet
    via `register_sender`. Verified end-to-end against a faithful RPC mock;
    live execution lights up when Azguard ships an AZUP-2 build.
- **Self-serve onboarding:** "Get test tokens" claims from the open faucet.
- Chain-reset hardening: all chain-dependent local state (deploy flags, names,
  beacon bookkeeping) is scoped per registry deployment.

### Ops & tooling ([`scripts/`](scripts/))

- **Deploys:** `deploy:testnet` (token + AZNS → writes `dapp/.env`),
  `deploy:faucet` (+ minter approval + fresh-account open-claim proof),
  `deploy:beacon`.
- **Fees on a faucet-rationed testnet:** `fees.ts` picks the payer
  automatically (native fee juice → faucet claim → sponsored FPC) with a
  `FEE_MODE` override; `claim:fpc` consumes a faucet drip **for the shared
  sponsored FPC** (auto-detects the claim's recipient); `juice_watch` /
  `gas_probe` poll for drips landing / gas-price dips.
- **Live E2E suite** (all PASS on the v5 testnet): `charge:e2e` (fee
  enforcement: reverts broke, charges exactly), `discovery_e2e`, `relay_b_e2e`,
  `beacon_a_e2e`, `pay_browser_e2e`.

---

## Lease & pricing (ENS-style)

Names are **rented per year** — $21/yr flat across modes ($ held as USD cents
on-chain; `unit_per_cent` converts to token base units at deploy time). Labels
are 3–31 characters, enforced on-chain.

- **Register** charges `price × years` and sets an expiry; the name resolves to
  its owner immediately.
- **Renew** extends the lease; anyone may pay to renew any name.
- **Grace period** (90 days): only the prior owner may renew. After grace, the
  name is freely registerable again. `lease_status()` → 0 available / 1 active
  / 2 grace.
- **Fee settlement is real:** the contract pulls the fee from the buyer's
  balance via `Token::transfer_in_private` (authwit-authorized) into the
  treasury. Testnet uses a disposable test token; a mainnet deploy points
  `payment_token` at a USD-pegged stablecoin and sets the real
  `treasury`/`unit_per_cent` — no oracle needed.

**Trustless pricing:** registration is priced by the same `mode` value that
gets written to storage. Renewals charge the claimed mode in private and the
enqueued public step asserts it equals the stored mode — underpaying reverts.
The label length is bound *into* `name_hash`, so lying about length produces a
hash that doesn't match the name.

**Takeover safety:** when a lapsed name is re-registered, a per-name epoch
increments, so the previous owner's outstanding selective grants stop
resolving.

---

## Revenue / treasury

Every registration and renewal fee is pulled **directly into the `treasury`
address** — a constructor argument, held as `PublicImmutable`: it is fixed at
deploy time and there is deliberately **no "change treasury" function**. Pick
it carefully; changing it means deploying a new registry.

- **Current testnet deployment:** `TREASURY_ADDRESS` was left unset, so it
  defaulted to the deployer account (`scripts/.deployer.json`, gitignored).
  Fine for testing — the fees are worthless faucet-minted test tokens.
- **Mainnet checklist:** deploy with `TREASURY_ADDRESS` set to a dedicated
  cold wallet or multisig (never the hot deployer key), `PAY_TOKEN_ADDRESS`
  set to a real USD-pegged stablecoin, and `UNIT_PER_CENT` set to the
  stablecoin's base-units-per-cent (e.g. `1e16` for 18 decimals).
- **Fees arrive as PRIVATE notes.** `transfer_in_private` means revenue is
  invisible on-chain — and the treasury operator has the same note-discovery
  reality as any recipient: fee notes from unknown buyers surface after
  registering the payer (`revealFrom`) or via the discovery beacon. Plan the
  treasury's wallet tooling accordingly; don't assume a block explorer will
  show income.

```
truprotocol/
├── azns/                 registry contract (main.nr, resolution_note.nr, test.nr)
├── faucet/               open-mint test-token faucet contract
├── beacon/               payment-discovery beacon contract
├── dapp/                 the browser dApp (vite + React)
│   └── src/
│       ├── aztec.ts      service layer: wallet modes, flows, beacon discovery
│       ├── azguard.ts    Azguard external-wallet adapter (version-neutral RPC)
│       ├── AzguardButton.tsx  topbar connect control
│       └── contracts/    generated TS bindings (synced from */target)
├── scripts/              deploys, fee tooling, live E2E suite, shared lib.ts
└── package.json          tsx-based script entrypoints (deploy:*, charge:e2e, …)
```

---

## Build & run

Development happens in **WSL** (Ubuntu) on Windows or any Linux/macOS shell.
Proving is client-side — no Docker needed for the testnet flow.

```bash
# 1. Toolchain — pin the EXACT version the target network runs.
bash -i <(curl -s https://install.aztec.network)      # installs aztec-up
aztec-up install 5.0.0-nightly.20260701               # match package.json
# installs to ~/.aztec/versions/<v>/bin (activated via ~/.aztec/current/bin)

# 2. Compile contracts + generate TS bindings
cd azns   && aztec compile --force && cd ..
cd faucet && aztec compile --force && cd ..
cd beacon && aztec compile --force && cd ..
aztec codegen ./azns/target   -o ./azns/target
aztec codegen ./faucet/target -o ./faucet/target
aztec codegen ./beacon/target -o ./beacon/target

# 3. Scripts
npm install
npm run deploy:testnet     # token + AZNS  -> writes dapp/.env
npm run deploy:faucet      # faucet + minter approval + open-claim proof
npm run deploy:beacon      # payment-discovery beacon -> dapp/.env

# 4. dApp
cd dapp && npm install && npm run build && npx vite preview --port 5173
```

> **Version discipline.** `azns/faucet/beacon Nargo.toml` tags, the root
> `package.json`, and `dapp/package.json` must all pin the SAME aztec version,
> and the `aztec` Noir dep must come from the same source tree as the `token`
> dep (`noir-projects/aztec-nr/aztec`) or Nargo sees two distinct crates.

### Fees on the testnet

The deployer account is funded from the faucet
(<https://aztec-faucet.dev-nethermind.xyz> — one fee-juice drip per 8h): paste
an address, then consume the claim with `CLAIM_AMOUNT/SECRET/INDEX` env vars —
`setupDeployer` bootstraps the account with it, or `npm run claim:fpc`
finalizes a drip made to the **shared sponsored FPC** (which pays for dApp
browser accounts). `FEE_MODE=sponsored` routes deploys through the FPC.

### dApp serving notes (nightly SDK)

The browser PXE persists in a **SQLite-OPFS worker**; three things matter
(already wired in this repo, documented for posterity):

1. Serve the **production build** (`vite preview`) — the dev-mode dependency
   optimizer breaks the worker three different ways.
2. `sync.mjs` ships `sqlite3.wasm` (unhashed name) + the OPFS async-proxy
   worker via `public/assets/` — rollup doesn't emit them, and vite's SPA
   fallback would silently answer the wasm path with `index.html`.
3. COOP/COEP headers go on **every** response (a middleware covers dev +
   preview) — module workers need them on their own response under
   cross-origin isolation.

---

## Testing

- **TXE (contract) tests:** `azns/src/test.nr` — 15 tests covering modes,
  lease lifecycle, pricing enforcement, records, epochs, and the token charge
  (deploys a real Token, mints, builds the fee authwit).
  Requires the canonical transpiled Token artifact in `target/` (see the
  header comment in `test.nr`), then `nargo test --test-threads 1`.
- **Live E2E (run against the public testnet):**

| Script | Proves |
|---|---|
| `charge:e2e` | fee is enforced: register reverts at 0 balance, charges exactly the fee when funded |
| `discovery_e2e` | an incoming note is invisible until `registerSender(payer)`, then a historical back-scan reveals it |
| `relay_b_e2e` | Option B: recipient learns the payer from an off-chain relay only |
| `beacon_a_e2e` | Option A: recipient finds the log by recomputing its own siloed tag from public key material |
| `pay_browser_e2e` | the dApp discovers an unknown payer's payment autonomously (used with the browser open) |

---

## Version landscape (read before touching anything)

- The public **testnet runs the AZUP-2 / v5 pre-release line** (rolling `dev`
  node ≈ the latest `5.0.0-nightly.*`; npm dist-tag `prerelease`). It resets
  occasionally — all chain-dependent dApp state is scoped per deployment, and
  redeploying is one command chain.
- **Aztec mainnet ("Alpha") runs 4.3.1 today; AZUP-2 (v5) reaches mainnet in
  July 2026** — at which point the wallet ecosystem (Azguard targets 4.x today)
  converges with this codebase's line and the external-wallet path executes
  live. The dApp's Azguard integration is deliberately version-neutral so no
  code changes are needed then.

## Safety

- **Unaudited. Do not hold real value.** A security audit is a hard gate before
  any mainnet deploy.
- Permissionless by design: no KYC, no allowlists — squat resistance comes from
  pricing and the lease lifecycle, not identity.
- The dApp embeds **no funded keys**: the embedded wallet is per-browser
  self-custody; production users bring their own wallet.
- Secrets never enter git: deployer keys (`scripts/.deployer.json`),
  deployment env (`dapp/.env`), and local run helpers are gitignored.
