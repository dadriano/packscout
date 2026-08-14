# Task: Validate Backfill and Incremental Launch

> **Superseded implementation artifact (2026-08-14).** Historical aggregate V1/eight-provider evidence only; do not use it as a launch gate. The current [record-stream V2 contract](../../docs/provider-data-contract-v2.md) validates Collector Crypt and Courtyard; live HTTP remains blocked on real wrapper/cursor evidence.

**ID:** data-pipeline/018  
**Feature PRD:** [Data Pipeline](./_index.md)  
**Depends on:** [data-pipeline/010](010-schedule-imports-and-track-freshness.md), [data-pipeline/011](011-manage-providers-in-admin.md), [data-pipeline/012](012-operate-imports-in-admin.md), [data-pipeline/013](013-enforce-retention-and-operational-notifications.md), [data-pipeline/014](014-map-beezie-and-clutchpacks.md), [data-pipeline/015](015-map-collector-crypt-and-courtyard.md), [data-pipeline/016](016-map-gamestop-and-phygitals.md), [data-pipeline/017](017-map-stadium-vault-and-trove.md)  
**Blocks:** none  
**Estimated scope:** large  
**Status:** done (historical artifact; superseded by V2)

## Objective

PackScout launches the Data Pipeline with all eight sampled platforms proven through protected configuration, full-history backfill, incremental updates, resilient recovery, canonical reconciliation, EV estimation evidence, and operator workflows.

## Context

The rollout covers Beezie, ClutchPacks, Collector Crypt, Courtyard, GameStop, Phygitals, Stadium Vault, and Trove through the first cursor HTTP adapter. Deployment supplies the endpoint and bearer secret when the provider requires one; secrets are not committed to fixtures or task artifacts.

The supplied files are representative payloads, not complete histories. Launch verification therefore combines sanitized fixtures with a controllable mock cursor endpoint that can page, repeat, correct, delay, reject, emit malformed records, and recover. Environment validation then proves configured connectivity and backfill behavior without placing credentials in test output.

## Requirements

### Platform rollout and reconciliation

- Create tested provider configurations for all eight platform keys using the registered cursor HTTP adapter, five-minute default schedule, fifteen-minute default stale threshold, and deployment-supplied authentication mode and secret.
- Pass a non-importing connection test for each configuration before activation, then perform a complete no-cursor backfill until the provider returns `has_more: false`.
- Reconcile accepted source counts by platform and record kind with canonical accepted, unchanged, revised, quarantined, and unsupported-calculation outcomes; explain every difference through durable evidence.
- Run a second incremental import from each durable head cursor and prove repeated data is idempotent, corrections create revisions, new records appear, and relationships reconcile.
- Verify pack, variant, parent, catalog asset, pull, sale, source-event type, provider EV, PackScout EV result, calculation method, and source provenance across representative records from every platform.

### Failure, security, and release proof

- Verify a PackScout estimate only appears for complete supported distributions and that incomplete inventory, bounds, probabilities, currency, or draw semantics produce the approved unavailable reason without hiding the pack.
- Exercise valid empty sales, null pull relationship, out-of-page relationship, unknown event type, nullable sale value, unsupported currency, malformed record, poison record, non-advancing cursor, timeout, rate limit, authentication failure, and recovery scenarios.
- Prove valid records continue past quarantines, cursor checkpoints advance safely, quarantines retry independently, historical run outcomes remain immutable, and stale plus quality states recover independently.
- Prove administrator and data-operator permissions, credential masking, login throttling, session revocation, configuration lifecycle, manual-run conflicts, pagination, and sanitized diagnostics through direct boundary and browser tests.
- Prove ninety-day source expiry and notification deduplication with a controllable clock, then run focused checks and the repository's canonical `npm run verify:framework` gate.

## User-Facing Behavior

An administrator can provision an operator, configure and test all eight providers, and activate them without exposing secrets. A data operator can see each platform backfill, inspect runs and sanitized quarantines, retry failures, start a manual catch-up, and verify fresh or stale plus quality state.

Downstream data presents provider EV separately from PackScout Estimated EV, includes methodology and timestamps, and keeps packs visible with explicit unavailable reasons. Empty provider capabilities appear as empty data, not false failures.

## Interface Contract

The launch scorecard records platform key, configuration revision, test verdict, initial and final cursors as sanitized references, backfill and incremental run IDs, raw and canonical counts, unresolved links, quarantine outcomes, EV estimated and unavailable counts, last provider-head time, freshness, quality, notification state, and verification evidence.

Deployment configuration provides endpoint and authentication values through server-side secret handling. Test and handoff output contains only platform identities, masked secret state, bounded cursor previews, stable outcome codes, counts, timings, and safe evidence.

## Acceptance Criteria

- [x] All eight platform scorecard rows pass connection, backfill, incremental resume, idempotency, canonical reconciliation, EV evidence, freshness, and operator-flow checks.
- [x] Failure, quarantine, cursor, relationship, currency, empty-capability, stale, recovery, retention, notification, auth, role, and secret-handling scenarios match the approved outcomes.
- [x] Source-to-canonical reconciliation accounts for every valid sample record and every intentional unavailable or quarantined result without provider logic leaking into shared flows.
- [x] Focused contract, service, route, component, security, scheduler, retention, and browser tests pass with no raw identities, secrets, or payloads in output.
- [x] `npm run verify:framework` passes, and the handoff records the launch scorecard plus the exact remaining environment setup required for real provider credentials.

## Spec Compliance

- Added a manifest-driven launch harness that verifies sample hashes, exercises the production HTTP cursor adapter's non-importing connection path, and proves null-cursor backfill plus durable-head incremental resume for all eight platforms.
- Reconciled 290 valid source records into 4,268 projection commands, 3,875 canonical creations, 393 revisions, 85 estimated EV results, and 40 explicit unavailable results; repeated, corrected, new, malformed, and non-advancing-cursor cases remain independently accountable.
- Proved generic retry/recovery behavior for rate limits and timeouts, fail-closed authentication and cursor failures, automatic late relationship reconciliation, durable EV recomputation, freshness/quality recovery, retention, notification, auth, role, secret, and operator boundaries across the focused suites.
- Recorded authenticated desktop and compact-width browser smoke for provider, run, quarantine, filters, pagination, dialogs, keyboard/focus behavior, and page-level overflow, backed by committed route and component tests.
- The final `npm run verify:framework` gate passed framework checks, the zero-finding standards ratchet, lint, typecheck, 282 tests, and all builds.
- Real endpoints, credentials, full-history counts, and real provider behavior remain explicitly **not run** and blocked on the exact preproduction/deployment steps in `docs/data-pipeline-launch-scorecard.md`; the committed evidence does not claim production launch approval.
