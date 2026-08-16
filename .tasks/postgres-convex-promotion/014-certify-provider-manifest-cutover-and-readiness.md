# Task: Certify Provider-Manifest Cutover and Readiness

**ID:** postgres-convex-promotion/014
**Depends on:** postgres-convex-promotion/007, postgres-convex-promotion/008, postgres-convex-promotion/009, postgres-convex-promotion/010, postgres-convex-promotion/011, postgres-convex-promotion/012, postgres-convex-promotion/013
**Blocks:** none
**Estimated scope:** large
**Estimated effort:** 3–5 days for one builder after target-environment access is available, including cutover rehearsal and failure injection
**Status:** not started

## Start Here

Run the first-activation scenario with two enabled providers in one configuration epoch, then capture both provider completion receipts, the global manifest activation receipt, the active pointer, unchanged public DTO output, and one exactly aligned Heat frame.

## Objective

Prove the provider-release and global-manifest architecture can replace the unlaunched single-release model cleanly, meet its operational targets, recover exactly, and preserve the existing public catalog and Heat behavior.

## Context

The prior certification task proved much of the single-release implementation locally but could not complete target-environment performance, key-rotation, external liveness, or reset evidence. That task is superseded by this final certification because the active artifact, publication phases, Heat alignment proof, and retention graph have changed. Historical evidence remains useful as a test baseline, but every launch-critical result must be rerun against the provider-manifest architecture.

## Requirements

### Clean prelaunch cutover

- Provide one environment-scoped, explicitly authorized prelaunch reset for obsolete Convex single-release catalog/Heat publication artifacts and superseded PostgreSQL promotion-only state; preserve canonical PostgreSQL history, causal settlement, normalized Heat observations, and approved configuration.
- Deploy only the provider-release, manifest, and manifest-aligned Heat contracts after the reset. Do not ship compatibility tables, legacy fallbacks, dual reads, dual writes, provider aliases, or provider-specific branches in generic orchestration.
- Validate organization/deployment binding, signing keys, request limits, provider and manifest timing, batch limits, configuration epoch, retention, and alert thresholds at startup with stable errors.
- Require exact proven-empty or active-manifest bootstrap before any provider or manifest lane claims work.
- Record the cutover order, stop conditions, recovery authority, rollback limits, and evidence-redaction rules in the operational runbook.

### Catalog and manifest certification

- Prove first activation waits for every enabled provider, same-epoch compatibility, complete backfill, and settled affected derivations.
- Prove independent provider cadence, unchanged release reuse, delayed-provider active fallback, newly enabled readiness, disable-only-through-manifest, and the all-provider new-epoch barrier.
- Prove completed and active provider heads remain separate through successful, failed, retried, and compare-and-swap-losing attempts.
- Prove exact request/receipt recovery for provider and manifest phases across restart, stale claim, replay, lost acknowledgement, timeout, malformed receipt, hash/count mismatch, block, rollback, clear, and key rotation.
- Prove every failed stage or activation leaves the prior complete manifest readable and never exposes an unselected provider release.

### Public, Heat, and retention certification

- Run the existing public contract/frontend suites plus cross-provider search at the eight-platform launch bound, facets, sorting, details, desired-collectible matching, pagination reset, freshness, delayed, unavailable, and no-safe-manifest scenarios without DTO changes.
- Prove Heat accepts only the active manifest and exact provider-release set, remains independent of catalog activation, and expires fail closed after 15 minutes.
- Prove active/previous and rollback manifest safety, per-provider completed/active head protection, three-additional/seven-day bounds, 24-hour abandoned cleanup, and 100-document deletion limits.
- Prove blocked, retained, shared, and in-flight provider releases cannot become dangling manifest references.
- Verify the reset and retention paths affect only publication artifacts and never canonical PostgreSQL state or protected source data.

### Performance and operations

- Measure settled provider checkpoint to confirmed manifest activation and Heat frame p50/p95/max/error results at representative preproduction volume; healthy p95 is under one minute for both lanes.
- Emit non-secret health and alerts for per-provider settled/completed/active lag, manifest epoch/age/retry/CAS failure, delayed count, reconciliation mismatch, Heat alignment/age/expiry, and terminal failure.
- Rehearse overlapping signing-key rotation, manifest rollback, retention, and old-key retirement through the target secret manager and authenticated deployment.
- Configure and fire an external worker-liveness/no-advancing-Heat monitor before the 15-minute Heat expiry boundary.
- Run focused suites, the full end-to-end evidence matrix, and `npm run verify:framework` on the exact launch commit.

## User-Facing Behavior

The first public catalog appears only when every enabled provider is ready in one configuration epoch. Later provider delays retain that provider's previous values with truthful freshness while other providers can advance. Every catalog change remains atomic, public DTOs remain unchanged, and Heat becomes unavailable rather than attaching to the wrong manifest.

## Interface Contract

The launch evidence package records, without secrets or protected source data:

- canonical fixture/version, approved organization/deployment digest, configuration epoch, and enabled-platform set;
- per-provider affected-settled, completed, and active checkpoints with exact request and receipt digests;
- active/previous manifest identities, canonical provider references, aggregate hashes/counts, pointer compare-and-swap results, and public DTO hashes;
- Heat manifest/provider-set alignment, source watermark, frame hash/counts, expiry outcome, and terminal receipt digest;
- cutover/reset proof, retention graph results, timing/volume results, alert/monitor evidence, exact commit, and reproducible commands.

The runbook names protected operator actions and stable outcomes only. It contains no signing secret, raw payload, actor, tenant selector, quarantine detail, or provider credential.

## Acceptance Criteria

### Cutover and bootstrap

- [ ] The approved reset removes only obsolete publication state, the new schema starts cleanly, and no compatibility or dual path remains.
- [ ] Missing or unsafe configuration fails startup, and partial/mismatched bootstrap proof prevents every publication claim.
- [ ] Canonical PostgreSQL history, causal settlement, approved configuration, and normalized Heat observations survive the cutover unchanged.
- [ ] The runbook reproduces cutover, stop, retry, rollback, clear, rotation, retention, shutdown, and evidence-redaction outcomes.

### Catalog recovery

- [ ] Initial readiness, independent cadence, unchanged reuse, delayed fallback, enable, disable, and new-epoch barrier scenarios match the resolved architecture.
- [ ] Restart, replay, lost acknowledgement, stale claim, network retry, deterministic failure, and manifest compare-and-swap loss terminate without duplicate, partial, or regressed public data.
- [ ] Exact provider and manifest receipts reconcile PostgreSQL completed/active heads to Convex state after every injected failure.
- [ ] Rollback, clear, manifest block, key rotation, and retention preserve all pointer and reference safety rules.

### Public and Heat behavior

- [ ] Existing public catalog and frontend behavior passes unchanged across a multi-provider active manifest.
- [ ] Delayed freshness is truthful, metadata-only refresh preserves the public release identity, and a manifest content change resets cursors through the existing behavior.
- [ ] Heat binds the exact active manifest/provider set, fails closed on mismatch or 15-minute expiry, and never blocks catalog activation.
- [ ] No public, observability, runbook, or evidence artifact contains protected provider, tenant, actor, credential, raw, or quarantine data.

### Launch evidence

- [ ] Representative hosted results meet the under-one-minute provider-to-manifest and Heat p95 targets without exceeding publication bounds.
- [ ] External process-down monitoring fires before Heat expiry and resolves after recovery.
- [ ] Signing-key overlap, old-key retirement, rollback, and retention are rehearsed against the target secret manager and deployment.
- [ ] `npm run verify:framework` passes on the exact certified commit.

## Verification

`npm run verify:framework`

## Historical Baseline Evidence to Re-run

- The single-release local suites previously proved deterministic assembly, initial/delayed readiness, exact-byte restart/status recovery, stale claims, ambiguous signed responses, pointer safety, rollback/clear, nonce replay, bounded catalog/Heat retention, and 15-minute Heat expiry.
- Durable alerts previously covered activation delay, technical settlement blocks, terminal/reconciliation failures, and cross-restart recovery without storing secrets or deployment keys.
- A protocol-maximum local catalog fixture previously completed preparation within one minute, and an 8,000-repack Heat fixture completed 252 operations in one cycle.
- The prior runbook documented configuration, recovery, retention, rollback, clear, rotation, shutdown, evidence redaction, and launch gates.

These results are historical regression inputs, not certification of the provider-manifest architecture.
