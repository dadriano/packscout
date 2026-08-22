# Task: Establish the Closed-Beta Access Decision

**ID:** closed-beta-access/001
**Depends on:** admin-tools/002
**Blocks:** closed-beta-access/002, closed-beta-access/003, closed-beta-access/004, closed-beta-access/005, closed-beta-access/007
**Estimated scope:** medium
**Status:** in_progress

## Objective

Every product identity carries an authoritative admission decision — awaiting review, approved, or declined — and the product backend can answer "may this visitor use PackScout?" for a signed-in identity and "is the closed beta on?" for an anonymous one, with a single deployment switch that closes or opens the beta.

## Context

PackScout is going into closed beta: the product stops being open to the public and admits only people on an operator-managed allowlist or approved by hand.

The product-user directory already records every sign-in — stable subject identity, authentication source, email and/or wallet address when the provider exposes them, first- and last-seen times, and a standing of active or suspended. Standing answers "has this account been disciplined?" It does not answer "is this account admitted to the beta?": a brand-new sign-up is active-standing and must still not get in. This task adds that second, independent dimension and makes it the single source of truth every other task in this feature reads.

The approved reference web app models exactly this: an account status that defaults to pending, is flipped to active by an allowlist match at sign-in or by an operator in the admin, and is re-read from the database on every authoritative check because a token minted earlier can be stale. PackScout adapts the pattern to third-party-token sign-in: there is no registration form, so the decision is established on first authenticated contact and re-resolved on later requests — never trusted from a claim, a cookie, or a cached session.

One rule deserves stating up front because it deliberately inverts a neighbouring one: **an identity with no directory record is awaiting review, not approved.** Suspension enforcement (admin-tools/005) treats a missing record as active, because it asks "was this known account disciplined?" and absence means "never disciplined". Admission asks "was this account let in?" and absence means "not yet". Both fail closed for their own question; they must not be collapsed into one field.

## Requirements

- Each product-user record carries an access state with exactly three values: awaiting review (the default for a newly established record), approved, and declined. It is stored and reasoned about separately from standing (active/suspended).
- Every decision carries its provenance: what produced it (default, allowlist match, or an operator), when it was decided, and a reference to the matched allowlist entry or the acting operator. Provenance is data other tasks display and audit, not a free-text note.
- Effective access composes admission and standing in one place: a caller is admitted only when access is approved *and* standing is not suspended. Consumers ask for effective access and receive a reason they can act on (approved, awaiting review, declined, suspended, or undetermined) — no consumer reads the raw fields and re-derives the rule, so admission and suspension cannot drift apart.
- First authenticated contact establishes the record with awaiting-review access. Later contacts refresh identity attributes and last-seen without altering an existing decision, and never downgrade an approved account back to awaiting review.
- Because absence means "not admitted", establishment must be reliable enough to gate on: it runs as part of the authenticated request path rather than as an unobserved side effect, and a failed establishment yields an explicit undetermined outcome. Undetermined must never be reported, cached, or coerced into "admitted" anywhere in the system.
- A signed-in user can read their own effective access and reason, and nothing else — no other user's state, no counts, no operator data. The result must reflect a decision change promptly, without requiring the user to sign out and back in.
- An unauthenticated caller can read one thing: whether the closed beta is currently on. That read exposes no identity, no counts, and no catalog data, and stays reachable even after the catalog read model is closed (closed-beta-access/005), because the signed-out landing experience depends on it.
- A single deployment-level switch controls the beta. While it is on, deny-by-default applies everywhere. While it is off, effective access resolves to admitted for every caller including anonymous ones, so the product returns to fully public behavior with no code change. The switch is server-side configuration; no client input, header, or query parameter can influence it.
- Establishment and decision changes are idempotent and concurrency-safe: simultaneous first contacts converge on one record with one decision, and repeated decisions converge rather than corrupting state.
- Identity attributes used for admission are personal data: they never appear in logs, metrics, or error payloads beyond what the project's existing observability conventions allow for audit-relevant identifiers.

## User-Facing Behavior

Nothing visible on its own — this task establishes the fact that later tasks route on, enforce, and display. After it lands, a new sign-in is recorded as awaiting review rather than silently treated as a full user.

## Interface Contract

- The product-user record gains an access state — `awaiting_review` | `approved` | `declined` — plus decision provenance (`decidedBy`: default | allowlist | operator; `decidedAt`; and a reference to the matched allowlist entry or acting operator).
- An effective-access resolution keyed by the stable subject identity returns `{ admitted: boolean, reason: "approved" | "awaiting_review" | "declined" | "suspended" | "undetermined" }`. This is the only admission answer other tasks consume.
- An establishment call, invoked on authenticated contact, creates or refreshes the record and returns the caller's current effective access.
- An authenticated self-read returns the caller's own effective access and reason.
- An unauthenticated gate-status read returns whether the closed beta is on.
- Consumers: closed-beta-access/002 writes allowlist-provenance decisions through this state; closed-beta-access/003 writes operator decisions and reads by access state; closed-beta-access/004 and closed-beta-access/005 gate on effective access; closed-beta-access/007 routes on the self-read and the gate-status read.

## Acceptance Criteria

- [ ] A first authenticated contact from a new identity produces exactly one record whose access is awaiting review, with default provenance; concurrent first contacts converge on one record.
- [ ] A repeat contact refreshes identity and last-seen without changing an existing decision, and never returns an approved account to awaiting review.
- [ ] Effective access is admitted only for approved-and-not-suspended identities, and the returned reason distinguishes awaiting review, declined, and suspended.
- [ ] An identity with no record resolves to awaiting review, and an establishment failure resolves to undetermined — neither is ever reported as admitted.
- [ ] The authenticated self-read returns only the caller's own state; another user's state is unreachable through it.
- [ ] The unauthenticated gate-status read reports only whether the beta is on, and returns nothing about identities, counts, or catalog data.
- [ ] With the switch off, effective access resolves to admitted for every caller including anonymous; with it on, deny-by-default holds. No client-supplied value changes the switch.

## Verification

Product backend tests prove: default awaiting-review on first contact, idempotent and concurrent establishment, decision provenance, effective-access composition against suspended standing, missing-record and failed-establishment resolving to awaiting-review and undetermined respectively (and never to admitted), self-read isolation, the gate-status read's minimal surface, and both switch positions. The workspace typecheck and the product-backend test command exit 0.
