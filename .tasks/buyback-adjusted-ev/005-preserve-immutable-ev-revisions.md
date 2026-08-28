# Task: Preserve Immutable EV Revisions

**ID:** buyback-adjusted-ev/005
**Depends on:** buyback-adjusted-ev/002, buyback-adjusted-ev/003
**Blocks:** buyback-adjusted-ev/006
**Estimated scope:** medium
**Estimated effort:** 2–3 days for one builder, including revision identity, persistence safety, provenance, and replay verification
**Status:** done

## Start Here

Define one available and one unavailable canonical revision whose complete fingerprints can be replayed without creating duplicate history.

## Objective

PackScout preserves every completed buyback-adjusted calculation as an immutable method-versioned revision with enough protected provenance to explain, replay, publish, and distinguish it from historical pre-buyback results.

## Context

Changing the meaning of Gross EV cannot mutate old records or silently relabel them. The canonical store needs a new identity that includes every economic input and policy version while keeping protected evidence outside the public release.

## Requirements

### Revision identity

- Bind each revision to `packscout-buyback-adjusted-ev-v1`, its confidence-policy version, one product revision, and one coherent observation set.
- Fingerprint every governing price, currency, odds, pool, value, payout, eligibility, draw, freshness, source-revision, and approved-configuration input.
- Store available and unavailable outcomes with calculation time, data-as-of time, internal reasons, confidence inputs, and bounded provenance.
- Preserve pre-buyback revisions under their original method identities and never select them for the new method.
- Reject reuse of a calculation identity with different inputs, versions, evidence, or outputs.

### Persistence safety

- Keep raw provider payloads, credentials, organization identifiers, and protected calculation evidence outside public projections.
- Preserve organization and product scope on every relationship and reject cross-scope references.
- Bound evidence collections, reasons, batch sizes, and stored text under transaction and document limits.
- Make completed-current selection deterministic by method, product revision, observation, and completion state.
- Persist exact arithmetic relationships so corrupted or inconsistent available metrics fail validation.

### Replay and operations

- Return the existing revision for an identical completed fingerprint without duplicate writes.
- Keep failed or incomplete work separate from a completed result and prevent it from advancing successful freshness.
- Record created, unchanged, unavailable, and failed outcomes with bounded labels and without money or raw evidence in logs.
- Expose a protected trace from revision to normalized source revisions and policy versions for publication and launch verification.
- Prevent repeated invalid evidence from creating unbounded revision or alert volume.

## User-Facing Behavior

None directly. Users benefit because a displayed result always refers to one immutable calculation rather than a value that changed in place.

## Interface Contract

The persistence boundary accepts `PackScoutBuybackEvResultV1`, its protected calculation evidence, normalized source revision references, and effective fingerprint. It returns one immutable revision identity and sanitized publication projection.

The current-revision reader selects only completed revisions for the requested method version and never returns protected evidence or historical pre-buyback results.

## Acceptance Criteria

- [x] Available and unavailable revisions persist all approved identities, timestamps, versions, provenance, and arithmetic invariants immutably.
- [x] Identical replay is unchanged, conflicting identity reuse is rejected, and failed work cannot replace a completed revision.
- [x] Historical pre-buyback results remain distinguishable and are never selected or relabeled under the new method.
- [x] Scope, bounds, logs, and projections expose no raw payload, credential, organization identifier, or protected evidence publicly.
- [x] A deterministic trace proves the exact normalized source, calculator, confidence policy, and output behind each revision.

## Spec Compliance

- Related specs reviewed: none (no tech-*/ux-* companion specs exist for this feature)
- Alignment: implemented as specified — three additive PostgreSQL tables (immutable completed revisions with DB-enforced four-metric arithmetic, protected source-ref trace, deduped failure ledger), fingerprint/result-hash identity with replay-unchanged and conflict-rejection semantics, method-versioned reader that structurally excludes pre-buyback rows, sanitized projection scanned against the protected-field vocabulary, and bounded operational events with no money values.
- Divergences: (1) EXPECTED_MIGRATION pin in packages/database/src/database.ts and two migration-name literals in database.lifecycle.test.ts updated beyond the listed shared files — structurally required by any new migration, matching prior migration commits; (2) failed work lives in a separate failures table with explicit lifecycle checks rather than a mixed-lifecycle revisions table, keeping completed uniques and immutability triggers unconditional; (3) the effective fingerprint excludes the calculation clock (replay semantics match the old method) — the clock is pinned by the result hash so clock-drifted redelivery is rejected as RESULT_CONFLICT instead of minting history. Design discovery recorded: an available calculation composed with an expired task-003 evaluation persists as an unavailable STALE_EVIDENCE revision.
- Verification: 16 focused tests (DB-backed integration executed against migrated throwaway PostgreSQL databases), db:prisma:validate, test:prisma-schema 5/5, test:prisma-lifecycle 5/5, package typecheck+lint for database and services, ratchet 0 new findings — all re-run independently by the orchestrator. Task file predates a ## Verification anchor; the focused suites plus prisma gates are the fallback anchor.
