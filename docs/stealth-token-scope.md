# Stealth payments — custom-token build scope

**Status:** scoping only. Nothing here is built. The goal is to decide *whether*
and *how* to make truProtocol's STEALTH mode match its claim — "each payment
lands on a fresh, unlinkable one-time address only the recipient can find" —
and to gate the biggest unknown behind a cheap spike before committing.

## 0. What must be true (the claim to match)

Anyone can pay `ghostline.tru` with **no coordination and no interaction**, and:
- each payment lands at a **different** owner, so two payers who compare notes
  can't tell they paid the same person, and no persistent address is exposed;
- only the name's owner can **spend** the funds;
- amount/sender stay private (Aztec already gives this for any private note).

## 1. Why the standard token can't do it (settled)

Proven offline by [`scripts/stealth_probe.ts`](../scripts/stealth_probe.ts):
Aztec derives account keys via `sha512` and the `AztecAddress` via `poseidon2`
(`computeAddress`), so **neither is EC-homomorphic**. The classic stealth trick
(sender computes a one-time address `P = S + h·G` from the recipient's public
meta-key) needs the address to be a linear function of a secret — it is not.
So a sender can't name a recipient's one-time `AztecAddress`, the standard
token binds every note to such an address, and no un-deployed account can
nullify. **`computeAddress` is protocol-level → a custom *account* can't fix it
either.** The fix has to live in the *note ownership + nullifier*, i.e. a custom
token/note type.

## 2. The mechanism we WILL use

Ownership becomes a **raw Grumpkin point**, which *is* EC-homomorphic:

```
recipient meta-key:   S = s·G  (spend),  V = v·G  (view)   — published per name
sender, per payment:  r random; R = r·G;  h = H(r·V) = H(v·R)
                      one-time owner point  P = S + h·G          (sender-derivable)
recipient:            recovers spend scalar p = s + h  (only they know s)
                      and p·G == P                                (they own it)
```

A **StealthNote** is owned by `P` (stored as its coordinates), not by an
`AztecAddress`. It is spent by a circuit that proves knowledge of `p` with
`p·G == P` and emits a deterministic nullifier `poseidon2(note_hash, p)` — only
the owner can compute it, it's unique per note (no double-spend), and it leaks
nothing about `p`. The sender need not *prove* `P` was derived correctly (if
they lie, they only pay an address they control — their loss), which keeps the
*pay* circuit cheap; the cost concentrates in the *sweep*.

Discovery is **already solved** by the existing beacon: extend the announce
payload to carry `R`, and the recipient's watcher computes `h`, finds the note,
and can auto-sweep. No new discovery infrastructure.

## 3. Architecture fork (needs a product decision)

| | **A. Custom stealth token** | **B. Escrow over a standard token** |
|---|---|---|
| What it is | truProtocol ships its own token that natively supports both normal balances and stealth notes | A wrapper contract holds standard-token deposits and issues/redeems stealth notes |
| Works with a real external stablecoin? | **No** — payers must hold *this* token | **Yes** — any token |
| Pooled custody (honeypot)? | **No** — value lives in notes, never pooled | **Yes** — the escrow custodies deposits (new, large audit surface; today the protocol custodies nothing) |
| Value-conservation risk | Internal accounting, like any token | The pool must never over-release — theft-adjacent |
| Best for | truProtocol's own test/utility token; demos; a token designed for stealth from day one | "stealth payments in USDC-like assets" if that's a hard product requirement |

**Recommendation:** build **A** first. It's the clean, non-custodial design and
matches the current "no pooled funds" security posture the audit praised. Treat
**B** as a separate, later track only if paying stealth in an arbitrary external
stablecoin is a genuine requirement — and budget a dedicated audit for the
escrow, because a custody bug there is fund loss.

## 4. Contract surface (model A)

New Noir contract `stealth_token/` (or an extension of the existing token):
- `StealthNote { owner_x: Field, owner_y: Field, amount: u128, randomness: Field }`.
- `transfer_to_stealth(px, py, amount)` — debit caller's private balance, create a
  StealthNote owned by `(px,py)`, emit the encrypted amount. (Pay path.)
- `sweep(note, p, to: AztecAddress)` — assert `p·G == (owner_x,owner_y)`, nullify
  via `poseidon2(note_hash, p)`, credit `to`'s normal private balance; handle a
  change note if partial. (Claim path.)
- Standard balance functions (`transfer`, `balance_of_private`, mint for testnet).
- Beacon stays the discovery layer; announce carries `R`.

## 5. Client changes

- `payPrivately` stealth branch: read the name's meta-key, pick `r`, derive `P`,
  call `transfer_to_stealth`, announce `R` on the beacon.
- Watcher: on a stealth announce, compute `p`, locate the note, and either
  auto-sweep or surface a "claim" affordance.
- Sweep gas: a fresh recipient may need sponsored fees to sweep (same
  bootstrapping we already solved for the embedded wallet / FPC).

## 6. Hard problems & risks (honest)

1. **Grumpkin variable-base scalar-mul in Noir** — `p·G == P` in-circuit is the
   #1 unknown (constraint cost, proving time, API availability in this aztec-nr
   version). **This decides feasibility.** → Phase 0 spike.
2. **Nullifier / value-conservation soundness** — a flaw is double-spend or
   theft. Needs cryptographic review, not just tests.
3. **Custody fork** (§3) — product decision with a big security delta.
4. **Sweep UX + gas** — fresh, unfunded one-time context needs sponsored fees.
5. **Change handling + amount encryption** — standard token patterns, but must
   be exact.

## 7. Phasing (spike-gated)

- **Phase 0 — feasibility spike (days, GATE):** minimal Noir contract that mints
  a StealthNote owned by `P` and a `sweep` that proves `p·G == P` + nullifies;
  TXE test proving (a) the owner can sweep, (b) a non-owner cannot, (c) a second
  sweep fails. Measure proving cost. **If scalar-mul is infeasible/too costly
  here, stop — the rest is moot.**
- **Phase 1 — StealthToken (model A):** full balances + `transfer_to_stealth` +
  `sweep` + change + amount encryption; TXE suite; live E2E like the beacon
  tests.
- **Phase 2 — client integration:** payPrivately stealth path, beacon-carried
  `R`, watcher auto-discovery + sweep UX; browser E2E.
- **Phase 3 (optional) — escrow (model B)** only if external-stablecoin stealth
  is required; separate audit.
- **Gate:** a security audit before mainnet is mandatory — this is
  theft-adjacent code.

## 8. Effort

Weeks, not days, and cryptography-review-bound — dominated by Phase 0's answer
and the nullifier design. Until Phase 0 passes, the honest UI stance holds:
stealth today = "no advertised repointable pointer; pay my name, it reaches me
privately and auto-discovers" — the per-payment-fresh-address promise is not yet
live.
