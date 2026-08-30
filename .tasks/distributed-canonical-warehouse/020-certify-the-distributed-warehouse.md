# Task: Certify the Distributed Warehouse

**ID:** distributed-canonical-warehouse/020
**Depends on:** distributed-canonical-warehouse/008, distributed-canonical-warehouse/009, distributed-canonical-warehouse/010, distributed-canonical-warehouse/011, distributed-canonical-warehouse/016, distributed-canonical-warehouse/017, distributed-canonical-warehouse/018, distributed-canonical-warehouse/019
**Blocks:** none
**Estimated scope:** large
**Estimated effort:** 5–8 days for one builder, including full-flow acceptance, fault injection, representative volume checks, and the repository gate
**Status:** not started

## Start Here

Provision one clean central database and two provider databases, seed the approved provider-neutral fixtures, and record the expected IDs and checkpoints for the first complete end-to-end scenario.

## Objective

Certify in non-production that the clean distributed warehouse, current admin application, shared identities, immutable publication, frontend contracts, documentation, and failure isolation work together as approved.

## Context

Focused verification belongs inside every preceding task. This final task proves the combined system rather than replacing those tests. It uses provider-neutral fixtures because provider adapters and mappings are deferred. It performs no migration, legacy cleanup, production source population, or live manifest activation.

Certification must exercise at least two isolated provider databases so parallelism and outage isolation are real rather than mocked behind one shared authority.

## Requirements

### End-to-end data flow

- Bootstrap one `packscout` database and at least two `packscout_<provider_key>` databases from clean independent schemas and prove repeated schema deployment is a no-op.
- Run two providers concurrently with mixed catalog, pull, and market-event pages, including unchanged records, mutable updates, immutable facts, and partial quarantine.
- Correlate deterministic identities, create a provisional identity, preserve an ambiguous suggestion, and resolve an alias without changing retired public IDs.
- Publish a complete catalog version and two deterministic provider releases, then activate provider entries independently through one manifest.
- Serve coherent public list, search, detail, desired-collectible, cursor, unavailable-value, and saved-item behavior from the active manifest.

### Admin parity

- Exercise login, session expiration, sign-out, operator management, provider create/edit/test/activate/disable/archive, overview, runs, run detail, quarantine, alerts, health, and Data Feed Lab routes.
- Verify administrator and data-operator permissions, organization isolation, Origin, CSRF, throttling, session revocation, optimistic conflicts, and stable structured errors.
- Verify one Run now action per provider, mixed page counters, immutable run history, 1–50 quarantine retry outcomes, alert acknowledge/resolve/reopen, and direct provider audit correlation.
- Verify loading, empty, filtered-empty, forbidden, stale, partial, unavailable, conflict, destructive-confirmation, success, retry, and failure presentation.
- Verify keyboard operation, focus movement, live announcements, responsive layouts, and text-based state meaning across current admin routes.

### Fault and recovery matrix

- Inject central-down, each provider-down, Convex-down, network timeout, stale lease, stale generation, duplicate page, duplicate publication, lost receipt, and process restart faults.
- Prove one provider's failure cannot block another provider's commit, admin result, correlation recovery, release publication, or manifest gate.
- Prove page atomicity, run single-flight, cursor monotonicity, lease fencing, command idempotency, independent consumer checkpoints, and manifest compare-and-swap behavior.
- Prove prior active public data and saved user items survive every failed publication, reconciliation, rollback, and retention scenario.
- Prove every fault returns bounded sanitized evidence and recovers from the last confirmed local or Convex checkpoint.

### Performance and resource bounds

- Record numeric bounds for central and provider connection pools, cross-provider fan-out, provider query timeout, page size, page transaction duration, and retry queues.
- Record numeric bounds for correlation and promotion backlog, release construction memory and duration, publication batch size, manifest read latency, and cleanup batch size.
- Run representative-volume fixtures for categories, packs, collectibles, contents, pulls, market events, changes, quarantines, catalog identities, and public artifacts.
- Prove backpressure keeps one provider backlog from exhausting another provider or central observer resources.
- Verify metrics and diagnostics expose lag, saturation, timeout, retry, receipt ambiguity, and recovery without protected content.

### Final evidence

- Verify central and provider schema parity, independent readiness, contract generation, static analysis, focused suites, application suites, Convex validation, and public contract fixtures.
- Scan browser responses, Convex documents, logs, alerts, audits, diagnostics, and documentation for secrets, DSNs, raw runtime cursors, unauthorized provider payloads, unsafe actor identity, and upstream error bodies; verify the bounded Data Feed Lab exception stays transient.
- Compare canonical documentation and the interactive ERD against the actual central, provider, and Convex schemas and relationships.
- Record every acceptance scenario, observed bound, fault result, and remaining external dependency in one non-production certification report.
- Run `npm run verify:framework` and require it to pass without a bypass, weakened rule, or new baseline.

## User-Facing Behavior

The certified admin experience remains familiar and provider-focused, while the frontend reads coherent immutable data. A provider outage is visible and isolated. Saved identities survive release changes and aliases. No user encounters a partial release, cross-provider data leak, false healthy state, or secret-bearing failure.

## Interface Contract

The certification report records environment, schema versions, fixture versions, provider IDs, catalog and release IDs, manifest fingerprint, acceptance results, numeric performance bounds, fault outcomes, verification commands, and sanitized evidence locations.

Certification succeeds only when every task-owned acceptance contract passes together. Deferred source adapters, migration, Heat, and production activation remain external dependencies rather than hidden certification steps.

## Acceptance Criteria

### System acceptance

- [ ] Two isolated providers complete concurrent mixed runs, global correlation, catalog/provider publication, independent activation, and coherent public reads.
- [ ] Every current admin route and role passes security, organization, direct-provider, partial-outage, recovery, and accessibility scenarios.
- [ ] Provider, central, Convex, network, concurrency, duplicate, lost-receipt, restart, rollback, and retention faults preserve approved invariants.
- [ ] Representative-volume evidence records and satisfies explicit connection, time, memory, batch, backlog, and retry bounds.
- [ ] Secret and protected-data scans find no exposure across browser, Convex, logs, alerts, audits, diagnostics, or docs.

### Handoff acceptance

- [ ] Independent central and provider schema parity plus repeated no-op deployment pass.
- [ ] Public contract, saved identity, alias, unavailable-value, and Heat-independent catalog behavior pass.
- [ ] System documentation and interactive ERDs match the certified schemas, flows, terminology, and boundaries.
- [ ] The non-production certification report contains all acceptance and fault evidence with no unresolved product branch.
- [ ] `npm run verify:framework` passes without a bypass, weakened rule, or new baseline.

## Spec Compliance

- Implementation authority: `tech-001-database-schema-contract.md`.
- Certification requires one central and two isolated provider databases plus the active-manifest Convex model; deferred adapters, migration, Heat, and production activation remain excluded.
- No deviations are planned; acceptance evidence is recorded before this task is marked complete.
