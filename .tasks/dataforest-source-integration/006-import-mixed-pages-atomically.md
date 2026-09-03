# Task: Import Mixed Pages Atomically

**ID:** dataforest-source-integration/006
**Depends on:** dataforest-source-integration/003, dataforest-source-integration/005
**Blocks:** dataforest-source-integration/007
**Estimated scope:** large
**Estimated effort:** 3–4 days for one builder, including atomic persistence, idempotency, EV work, storage measurement, and runtime replacement
**Status:** done

## Start Here

Import one sanitized normalized Courtyard page and force persistence to fail immediately before cursor advancement; the first expected result is no partial canonical data, EV request, page diagnostic, or cursor change.

## Objective

Commit every normalized source page exactly once in effect so protected evidence, source lineage, valid observations, quarantined siblings, canonical changes, EV work, processor progress, normalized continuation, and the next opaque cursor cross one durable boundary together.

## Context

A valid normalized page may mix catalog, pulls, and trades for one platform. The source adapter owns raw-wrapper failure, while a normalized record-local failure can be quarantined without losing valid siblings. The existing PackScout persistence path already supports atomic page writes, canonical revisions, relationships, quarantine, and EV recomputation requests; this task adapts that path rather than replacing it.

This task also performs the production composition replacement. After it completes, generic imports resolve a pinned source adapter and pinned mapper independently, DataForrest is one production adapter behind the normalized page contract, and there is no runtime fallback to the old aggregate or independent-stream designs.

## Requirements

### Atomic page commit

- Bind provider, source instance and revision, `sourceTypeKey`, source-adapter and normalized-contract revisions, mapper key and version, identity namespace, durable request-attempt identity and terminal capture outcome, request-time supervisor fencing epoch, connection profile and revision, request-time connection-health generation, cursor codec and generation, requested cursor, page, normalized continuation, and next cursor to one commit.
- Commit the authoritative protected raw-page evidence, stable source-record keys, semantic observations keyed by effective source time and versioned normalized-content hash, page-and-record-index delivery occurrences with complete lineage and dispositions, canonical revisions, relationships, counters, page progress, normalized continuation, and next opaque cursor atomically.
- Advance only the importing source's cursor and only after every normalized observation has a durable inserted, revised, duplicate, or quarantined disposition.
- Write one sanitized `PAGE_COMMITTED` processor diagnostic in the same transaction with page number, counts, timings, bytes, continuation kind, a required minimum delay only for `poll_after`, and safe cursor fingerprints.
- Leave page, canonical, EV, diagnostic, and cursor state unchanged when validation, planning, mapping, persistence, or diagnostic persistence fails before commit.

### Record-local outcomes

- Preserve valid siblings when a record has missing identity, unknown stream, platform mismatch, mapping failure, immutable conflict, or broken discriminator.
- Store protected retry evidence and a bounded safe reason for each quarantined record without duplicating every accepted record payload.
- Count warnings and unresolved relationships separately from the four exclusive dispositions.
- Reproject retained quarantine evidence without rewinding the source cursor or replaying unrelated records.
- Reconcile unresolved pack and card relationships idempotently when their catalog dependencies arrive.

### Idempotency and cursor safety

- Treat the same source record, effective source time, normalized-contract/hash version, and normalized-content hash as exact semantic replay even on a different page or connection revision; add its delivery occurrence but no second semantic observation, canonical revision, or EV request.
- Persist changed source time or normalized-content hash as one semantic observation plus occurrence; create a catalog revision only for changed canonical content and quarantine changed kind or pack/card discriminator within the same frozen scope, pull content, or market-event content.
- Preserve source, adapter, connection, normalized-contract, mapper, page, record index, collection time, protected-evidence reference, and disposition on the occurrence without placing delivery lineage in the semantic hash.
- In the same atomic precondition, require the matching request attempt's terminal successful-capture outcome and require its request-time supervisor epoch to remain the current `active` owner; reject a nonterminal or mismatched attempt, released, superseded, expired, or `fenced_draining` epoch, stale run lease, disabled or replaced source, revoked credential revision, stale connection-health generation or open blocking connection episode, and old cursor generation before commit.
- Retry transient fetch failures against the same requested cursor and never restart from null after an action-required failure.

### Generic continuation and cursor guard

- Accept only `{ kind: continue }` with no delay and a nonnull next cursor or `{ kind: poll_after, minimumDelaySeconds }` with a required integer from 0 through 86,400; reject every other shape before persistence.
- For `continue`, fingerprint the next cursor and reject it if that fingerprint was previously committed for the same source and cursor generation, including A-to-B-to-A across runs or restarts.
- Commit the accepted next-cursor fingerprint and continuation atomically with the page so concurrent or replayed work cannot bypass cycle detection.
- Allow `poll_after` to preserve its requested cursor, including null, and use its required delay only for scheduling after commit.
- Never parse, convert, or transfer the cursor value in the importer; adapter grammar and immediate requested-versus-next validation remain task 003's responsibility.

### EV recomputation

- Enqueue one deduplicated EV recomputation request when a committed pack or EV-input revision changes inputs used by PackScout EV.
- Commit the EV request in the same transaction as the canonical revision, record disposition, page outcome, and cursor.
- Enqueue nothing for duplicate pages, collection-only replay, unchanged canonical content, or incomplete EV evidence.
- Roll back the complete page and cursor when a required EV recomputation request cannot be recorded.
- Preserve the existing separation between provider-reported EV, EV inputs, calculated EV, and market-event money.

### Runtime replacement

- Resolve the source adapter solely from the run's pinned `sourceTypeKey` and adapter revision, and resolve the platform mapper solely from its separately pinned key and version.
- Compose exactly one production DataForrest adapter into connection-test, source-test, and page-read paths, and compose the separate four-mapper registry only into import mapping; generic activation checks mapper descriptors without invoking a mapper.
- Remove DataForrest launch registration for aggregate catalog/pulls/sales pages, `has_more`, sale record kinds, and independent stream cursors in the same replacement.
- Keep deferred mapper implementations dormant, the alternate adapter test-only, and unregistered source types unavailable.
- Keep endpoint, auth mode, `/v1/events`, filters, `next_cursor`, `poll_after_seconds`, SDK objects, and `has_more` out of generic import composition and persistence contracts.

### Alternate-adapter integration proof

- Run a test-only Courtyard source adapter with a different raw wrapper, cursor grammar, continuation signal, and separate connection profile through the same generic import path.
- Seed a distinct test-only Courtyard source instance at null through task 002's persistence contract, preserve its opaque cursor exactly across commit and resume, and retain the separate DataForrest source's history and cursor; task 004 owns activation lifecycle.
- Feed the alternate normalized observations through the unchanged pinned Courtyard mapper and preserve canonical provider identity when record IDs share the approved replacement identity namespace and record-ID scopes.
- Prove the alternate source cannot mutate another provider and is absent from production composition; tasks 004 and 008 own admin invisibility.
- Reject an identity-namespace mismatch instead of adding an ID crosswalk, cursor converter, dual read, or reconciliation ledger.

### Capacity proof

- Measure representative committed storage by normalized tables, indexes, protected page evidence, quarantine, diagnostics, terminal request attempts, and their compacted lineage using task 001's sample plan.
- Extrapolate the measured footprint to the dated 14.5-million-record baseline plus 60-second steady-state request-attempt volume, fixed retention windows, and incremental growth; nonterminal attempts remain outside expiry until reconciled.
- Verify one bounded page batch does not grow memory with total page count and record the numeric peak used by the test environment.
- Require an explicit local database capacity and headroom preflight before task 010 may release the real backfill.
- Record observed database statements and page duration without imposing the former two-hour or host-relative memory gates.

## User-Facing Behavior

None directly. Task 008 presents only committed progress, safe failures, and quarantine outcomes.

## Interface Contract

One page attempt returns either a committed or already-committed result.

### Page result

| Result area | Required values |
|---|---|
| Lineage | Provider, source, adapter, normalized-contract, mapper, identity namespace, durable terminal request attempt, request-time supervisor epoch, connection revision and health generation, and other revision pins |
| Semantic observation | Stable source-record key, effective source time, normalized-contract/hash version, and normalized-content hash |
| Delivery occurrence | Page and record index, semantic-observation or invalid-outcome reference, adapter, connection, mapper, collection time, evidence reference, and disposition |
| Cursor | Requested and committed safe fingerprints, codec, and generation |
| Source counts | Catalog, pulls, and trades received |
| Dispositions | Inserted, revised, duplicate, and quarantined |

### Derived and scheduling result

| Result area | Required values |
|---|---|
| Annotations | Warnings and unresolved relationships |
| Derived work | Canonical revisions, relationship updates, and deduplicated EV requests |
| Continuation | Committed `{ kind: continue }` without delay or `{ kind: poll_after, minimumDelaySeconds }` with required bounded delay, page timing, and bytes |

A failed attempt returns a stable retry or action-required class and cannot change the committed cursor.

## Acceptance Criteria

### Transaction proof

- [x] Forced failures before cursor advancement leave no partial page, record, canonical, relationship, EV, diagnostic, counter, or cursor state.
- [x] One malformed record is quarantined while valid siblings and the complete page outcome commit with the next cursor.
- [x] Duplicate, correction, immutable conflict, identity-kind conflict, and relationship-recovery cases are deterministic.
- [x] Exact semantic replay across pages or credential revisions creates one new occurrence but no semantic observation, canonical revision, or EV request; changed time or content creates one semantic observation and occurrence with a deterministic catalog-revision or conflict outcome.
- [x] EV recomputation coalesces atomically for real input changes, enqueues nothing for duplicates, and rolls back the cursor on enqueue failure.

### Connection-fence proof

- [x] A blocking connection episode opened after response capture but before commit makes the captured page's health generation stale and rolls back every page, occurrence, canonical, EV, diagnostic, and cursor write.
- [x] Singleton renewal loss after response capture makes the page attempt's request-time supervisor epoch stale and prevents the same complete atomic write.
- [x] A control-plane failure that moves the still-current owner epoch to `fenced_draining` rejects captured page commits across every profile before the owner aborts or releases work.
- [x] A nonterminal, failed, or mismatched durable request attempt cannot coexist with a committed page; only its terminal successful-capture outcome satisfies the atomic precondition.

### Cursor-cycle proof

- [x] Immediate repeated cursors fail adapter validation, while A-to-B-to-A and longer repeats fail the generic source-generation guard before commit.
- [x] Restart, retry, run rollover, and credential rotation cannot erase committed cursor fingerprints or bypass the cycle guard.
- [x] `poll_after` may preserve a cursor, but a missing or invalid delay and a delay attached to `continue` are rejected.

### Abstraction proof

- [x] The generic importer resolves source adapter and mapper from separate immutable pins and contains no DataForrest transport or scheduling fields.
- [x] The test-only alternate adapter completes normalized continuation, atomic cursor commit, resume, unchanged Courtyard mapping, canonical deduplication, and source-provenance coverage.
- [x] A seeded alternate source starts from null, retains separate DataForrest source history, and rejects cursor transfer or identity-namespace mismatch; task 004 owns real replacement activation.
- [x] One source adapter or mapper failure remains source scoped and cannot change sibling sources or canonical identities.

### Replacement and capacity proof

- [x] Production composition registers one DataForrest source adapter and four pinned launch mappers, with no obsolete, alternate, or deferred launch path.
- [x] Concurrent provider commits cannot exchange cursors, records, counters, diagnostics, leases, or revision context.
- [x] Representative storage, index, retention, and bounded-memory measurements produce an approved capacity preflight for task 010.
- [x] Seven-day page evidence and 30-day quarantine evidence remain independently enforceable without removing durable normalized history.

## Verification

- PASS: focused adapter, importer, planner, quarantine, registry, and database relationship-validation suites (40/40).
- PASS: full atomic page integration suite (29/29), including exact replay, rollback, epoch/health fences, reversible EV, relationship races, alternate-adapter resume, and pause-boundary commit.
- PASS: cursor, observation, retention, history, diagnostic, and run-pin focused database set (9/9).
- PASS: capacity forecast v2, regenerated physical-storage artifact, authentic 100-page bounded-memory measurement, and live-volume preflight (3/3). The fail-closed one-year growth model requires 8,759,332,238,475 available bytes and correctly rejects this host for Task 010.
- PASS: full contracts suite (167/167); contracts, database, and services typecheck/lint.
- PASS: Prisma validate, schema, lifecycle, and setup focused gates; `git diff --check`.
- PASS: independent final Task006 audit; no surviving P1/P2 finding.

## Spec Compliance

- Related specs reviewed: none.
- Alignment: implemented the authentic completed-page capability, one atomic normalized commit, exact durable replay digest, semantic and relationship lineage, source-pinned EV lifecycle, quarantine retry, opaque cursor continuation, retention, production cutover, and real alternate-adapter path.
- Divergences: none. Task 007 owns live supervisor execution and Task 008 owns monitoring. Task 010 remains intentionally blocked by the measured capacity admission gate; no backfill was started on the undersized host.
- Verification: the commands and independent audit above; every Task006 acceptance criterion is directly covered.
