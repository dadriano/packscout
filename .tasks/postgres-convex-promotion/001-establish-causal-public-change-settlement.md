# Task: Establish Causal Public-Change Settlement

**ID:** postgres-convex-promotion/001
**Depends on:** none
**Blocks:** postgres-convex-promotion/002, postgres-convex-promotion/005
**Estimated scope:** large
**Estimated effort:** 2–4 days for one builder, including migration and concurrency verification
**Status:** done

## Start Here

Write a persistence scenario where one canonical change creates an Estimated EV obligation, the provider cycle ends, and the settled watermark remains behind until that obligation reaches a valid terminal outcome.

## Objective

Create a durable, organization-scoped causal ledger that tells promotion workers exactly how far public canonical state is settled and safe to export.

## Context

Provider pages and canonical revisions are committed transactionally, but Estimated EV runs in a separately leased queue and may lag behind imports. A provider cycle can therefore finish while derived public data is still unsettled. Promotion needs a database-ordered boundary that follows the cause through every derived obligation instead of inferring readiness from clocks or worker lifecycle events.

## Requirements

- Assign a monotonically increasing public-change sequence to every change that can alter public catalog or Heat output.
- Record the sequence in the same PostgreSQL transaction as the authoritative change; a committed public change can never exist without its promotion cause and a rolled-back write can never leave a cause behind.
- Cover provider projection changes, relationship resolution, Estimated EV outcomes, quarantine corrections, approved public-configuration/lifecycle changes, and approved manual corrections.
- Propagate the originating causal sequence into every derived work item and any replacement/retry of that work.
- Model required derivations explicitly enough to distinguish pending, valid business-unavailable, successful, and technical-failure outcomes.
- Treat successful and business-unavailable outcomes as settled. Keep infrastructure, timeout, malformed-output, and exhausted technical failures unsettled and observable.
- Compute the highest contiguous settled sequence per organization. A later completed change cannot skip an earlier unsettled change.
- Use lease and acknowledgement semantics that reject stale workers and make repeated claims/acks idempotent.
- Preserve an auditable reason when a sequence is blocked without exposing provider or quarantine detail to the public read model.
- Resolve the one approved PackScout organization in server configuration; callers cannot choose an organization through a public request.

## User-Facing Behavior

No new UI is introduced. Public readers continue seeing the last complete release while the watermark is unsettled, including when provider imports have finished but required derivations have not.

## Interface Contract

The database/service boundary exposes:

- `PublicChangeCause`: organization identity, ordered sequence, stable change kind, stable entity key, occurrence time, and the authoritative transaction that created it.
- `PublicDerivationObligation`: cause sequence, derivation kind/key, state, claim identity, terminal outcome classification, and timestamps.
- `SettledPublicWatermark`: organization identity, highest contiguous settled sequence, settlement time, and enough source-head metadata for later delayed-vendor calculation.
- Transaction helpers that canonical writers and derived-result writers use so sequence creation, obligation creation, and terminal acknowledgement cannot drift apart.

Downstream tasks consume only the settled watermark and public-safe change identity; they never read provider payloads from this ledger.

## Acceptance Criteria

- [x] A canonical write and its public-change cause commit or roll back together.
- [x] A public-affecting change with pending Estimated EV work does not advance the settled watermark when the provider cycle finishes.
- [x] A successful Estimated EV result advances settlement after all earlier obligations are terminal.
- [x] A legitimate unavailable Estimated EV result also advances settlement with its bounded business reason preserved.
- [x] A technical derivation failure blocks contiguous settlement and is claimable/retryable without duplicate obligations.
- [x] Concurrent workers cannot skip a sequence, acknowledge a stale lease, or regress the settled watermark.
- [x] Existing canonical writer, quarantine recovery, relationship, EV, configuration, and lifecycle paths use the causal boundary for public-affecting changes.

## Verification

`npm run test:database && npm run test:services && npm run test:worker`

## Spec Compliance

- Related specs reviewed: none
- Alignment: implemented an organization-scoped transactional cause ledger, derivation obligations, contiguous settled watermark, causal EV propagation, lease-safe acknowledgements, and server-bound PackScout organization resolution across production canonical/configuration/lifecycle writers.
- Divergences: no production manual-correction writer exists yet; the causal cause kind and transaction helper support that future approved path without adding a compatibility branch. Test-only setup helpers remain outside the production causal boundary.
- Verification: `npm run test:database && npm run test:services && npm run test:worker` (48 database, 150 service, and 20 worker tests passing); `npm run scan:framework-standards:ratchet` (0 findings); orchestrator independently reran both anchors.
