# AZNS — Stealth mode (design spec)

> Status: **proposal / not implemented.** Experimental. Aztec testnet has a known
> proving-system vulnerability (fix in v5); this is for design + testnet only.

## Goal

A 4th name mode where **anyone can pay a name**, but:

1. the payer never learns the recipient's persistent address,
2. nothing legible (name, address, amount) appears on a block explorer, and
3. separate payments to the same name are **mutually unlinkable** — ideally even if payers collude.

This is the classic **stealth address** primitive, applied to a name.

---

## What Aztec already gives you (important)

Two of the three properties are essentially free on Aztec, independent of naming:

- **Explorer hides everything (#2).** A *private* token transfer records only an opaque note commitment + nullifier + ciphertext. No recipient, no amount, no name. Always.
- **Third parties can't link payments to a recipient (#3, partial).** Note commitments include randomness and Aztec's note-discovery tags are derived from a sender↔recipient shared secret, so an outside observer — even one who knows the recipient's public address — generally cannot tie notes to that recipient.

What Aztec does **not** give you out of the box:

- **Payer-side unlinkability.** If a name resolves to a fixed public address `A`, every payer learns `A`. Colluding payers can see they all paid the same `A`, and any *public* action from `A` later deanonymizes it.

So the only genuinely new thing Stealth mode must add is: **paying a name without any payer learning a reusable identity, with a fresh unlinkable destination per payment.**

---

## Two designs

### Option 1 — "Public key, private payments" (pragmatic, low effort)

- The name resolves **publicly** to the recipient's Aztec **address / encryption public key**.
- The dApp's send flow forces a **private** transfer to it.
- Result: #1 partial (payer knows the address but it's only ever paid privately), #2 ✅, #3 ✅ against third parties, ✗ against colluding payers.
- **Cost:** almost none — it's `Public` mode + "pay privately" UX. No new crypto.
- **Use when:** tips, donations, "pay me" links where payer-collusion isn't a threat.

### Option 2 — "Stealth meta-key, one-time addresses" (full unlinkability)

- The name resolves **publicly** to a **stealth meta-key**: a spend pubkey `S` and a view pubkey `V` (points on Aztec's Grumpkin curve).
- Each payer derives a **fresh one-time destination** per payment; the recipient's real identity is never exposed and every payment lands somewhere different.
- Result: #1 ✅, #2 ✅, #3 ✅ even against colluding payers.
- **Cost:** real work (crypto + Aztec account-model integration + recipient scanning). See below.

The rest of this doc specs **Option 2**.

---

## Stealth derivation (Option 2)

Curve: **Grumpkin** (the curve Aztec uses for app/account keys), generator `G`, scalar
field order `n`. `H(·)` = a domain-separated Poseidon2 hash to a scalar.

**Recipient keys (one-time setup):**
- spend key `s` (secret), `S = s·G` (public)
- view key  `v` (secret), `V = v·G` (public)
- Publish meta-key `(S, V)` under the name (on-chain, public).

**Payer, per payment:**
1. random ephemeral `r`; `R = r·G`
2. shared secret `ss = H(r · V)`           (= `H(v · R)`, ECDH)
3. one-time pubkey `P = S + H(ss)·G`
4. send the **private** transfer to a destination controlled by `P`
5. attach `R` to the payment's discovery log (the "announcement")

**Recipient, scanning:**
- for each announced `R`: `ss = H(v · R)`; expected `P = S + H(ss)·G`
- if a received note is for `P`, the spend key is `p = s + H(ss) (mod n)` — only the holder of `s` can compute it.

Only the recipient (who knows `v`) can recognize payments; only the recipient (who knows `s`) can spend them. Each payment uses a different `P`, so destinations are unlinkable.

---

## Contract changes (the resolver part)

The contract is a **resolver**, not a router — it stores/returns the meta-key; the actual
payment + stealth math happen in the wallet. Minimal additions to `azns/src/main.nr`:

```
global MODE_STEALTH: u8 = 3;          // extend the mode enum (update the `mode <= ...` check)

// public meta-key per name (two Grumpkin points; store coords as Fields)
stealth_meta: Map<Field, PublicMutable<StealthKey, Context>, Context>,
// where  struct StealthKey { sx: Field, sy: Field, vx: Field, vy: Field }

#[external("public")]
fn set_stealth_meta(name_hash: Field, key: StealthKey) {
    assert(self.storage.owners.at(name_hash).read().eq(self.msg_sender()), "only owner");
    assert(self.storage.mode.at(name_hash).read() == MODE_STEALTH, "name is not stealth");
    self.storage.stealth_meta.at(name_hash).write(key);
}

#[external("public")] #[view]
fn resolve_stealth(name_hash: Field) -> StealthKey {
    self.storage.stealth_meta.at(name_hash).read()
}
```

- `register`'s `mode` argument already flows through; just allow `3`.
- No `grant` needed — resolution is public (anyone reads the meta-key), which is what
  lets *anyone* pay.
- The **announcement** `R` does **not** need its own contract storage: piggyback it on the
  token transfer's encrypted log / note (where the recipient already scans). If you want a
  dedicated channel, add `emit_announcement(R)` that emits a public log, but that slightly
  weakens privacy (links a tx to "some stealth payment").

## Wallet / dApp changes

- **Receiving:** on registering a Stealth name, generate `(s, v)`, store secrets locally,
  call `set_stealth_meta(name, {S, V})`. Add a background **scan** that walks announcements
  and adds discovered one-time notes to the user's spendable balance.
- **Sending:** in the "send to a name" flow, `resolve_stealth(name)` → `(S, V)` → derive
  `R, P` → submit a private transfer to `P` with `R` attached. The UI shows "sending to
  zamfaraops.tru"; the name and the derived address never hit the chain in the clear.

---

## Honest tradeoffs & open problems

- **One-time-account spending on Aztec is the hard part.** Aztec accounts are contracts;
  "a note owned by one-time key `P`" must be spendable. Practical path: the note is encrypted
  to `P`; the recipient derives `p` and imports it into their PXE to spend — i.e. the
  recipient sweeps stealth notes into their main account. This needs care to not relink on
  the sweep (sweep privately).
- **Recipient must scan** every announcement (compute one ECDH per payment). Fine for
  modest volume; needs an indexer/tag optimization at scale.
- **Curve / hashing must be Aztec-native** (Grumpkin + Poseidon2) so the math is cheap in
  a circuit and consistent with Aztec keys. Don't import a foreign (secp/ed) scheme.
- **Much of #2/#3 is already provided by Aztec.** If you don't need payer-collusion
  resistance, **Option 1 is dramatically simpler** and gets you "anyone pays, nothing on the
  explorer." Only build Option 2 if hiding the recipient *from payers themselves* matters.
- **Unaudited & experimental**, on a testnet with a known proving vuln. Not for real value.

## Progress

- ✅ **`MODE_STEALTH` + on-chain resolver shipped** — `StealthKey {spend, view}` per name,
  `set_stealth_meta` / `resolve_stealth` (`azns/src/main.nr`). Private mode removed.
- ✅ **Stealth crypto prototype validated** — `npm run stealth:demo` (`scripts/stealth_demo.ts`)
  proves the full loop on Grumpkin: derive one-time `P` from `(S,V)`, recover one-time spend
  key `p`, confirm `p·G == P`, and that two payments land on different unlinkable addresses.
- ⛔ **Blocked on standard Aztec accounts (found 2026-07-04) — this is an architectural wall,
  not "integration."** The scheme needs a sender to compute the recipient's Aztec address from
  public data alone (`S, V, R`). But Aztec derives every account key from its secret through a
  **hash-based KDF** (`deriveMasterIncomingViewingSecretKey`, `…Nullifier…`, `deriveSigningKey`,
  etc. — see `@aztec/stdlib/keys/derivation`), not a linear map. So the incoming-viewing pubkey
  is `ivpk = KDF(p)·G`, which is **not** computable from `P = p·G` — the additive homomorphism
  stealth relies on (`P = S + h·G`, recipient secret `s + h`) is destroyed by the hash. Aztec
  also ships **no native stealth** support. The *only* viable path is a **custom account
  contract with KDF-free (linear) keys** (`ivpk = P` directly, nullifier/signing keys
  sender-derivable), plus custom note delivery + a sweep, and verifying the **standard token
  still encrypts to and lets you spend from** such an account. That is a research spike with a
  real chance of hitting a protocol wall, not a wire-up.
- **Decision (2026-07-04):** scope full stealth as R&D; keep the dApp + README copy honest about
  what ships today (private-by-default transfers + no public address pointer + beacon
  auto-discovery — but payments route to the owner's account, *not* a per-payment one-time
  address) until the custom-account path is proven.
- **What still IS true & useful today, even without one-time addresses:** on Aztec a private
  `transfer` already hides the recipient on-chain (only encrypted note commitments appear; no
  address in cleartext; repeated payments to one address aren't linkable *without* its viewing
  key). So Aztec provides much of #1/#2 natively; the piece stealth-addresses would add is
  hiding the recipient **from the payers themselves** and avoiding a single long-lived address.

## Suggested path

1. Ship **Option 1** now (a "pay privately" toggle on a Public name). The dApp already
   enforces private transfers in `payPrivately`.
2. Build the wallet side of Option 2 on the validated prototype: derive `P` per payment, emit
   `R`, scan, sweep.
