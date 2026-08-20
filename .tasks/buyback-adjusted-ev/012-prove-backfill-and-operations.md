# Task: Prove Backfill and Operational Readiness

**ID:** buyback-adjusted-ev/012
**Depends on:** buyback-adjusted-ev/006, buyback-adjusted-ev/008, buyback-adjusted-ev/010
**Blocks:** buyback-adjusted-ev/013
**Estimated scope:** medium
**Estimated effort:** 2–4 days for one builder, including catalog recomputation, monitoring, failure drills, and rollback evidence
**Status:** in_progress

## Start Here

Create a release ledger that classifies every active repack as recomputed under the new method or deterministically unavailable and reconciles that ledger with a staged public release.

## Objective

PackScout can backfill the launch catalog, observe calculation health, recover from failures, and roll back coherently without relabeling old values or operating a dual-version runtime.

## Context

The change replaces a public economic metric across the complete data path. Operational readiness requires more than unit math: all active products, method distributions, publication state, stale transitions, and recovery behavior must reconcile before cutover.

## Requirements

### Backfill and cutover

- Inventory every pre-buyback calculator, projection, public field, sort, KPI, fixture, glossary term, example, and telemetry label affected by the semantic change.
- Recompute every active supported repack under the new method or assign its deterministic unavailable reason.
- Keep historical pre-buyback revisions under their original identity and out of the new release.
- Replace mock and canonical active releases without aliases, dual reads, dual writes, mixed versions, or silent reinterpretation.
- Reconcile backfill totals, available counts, reasons, confidence bands, versions, and public release counts before activation.

### Observability and privacy

- Monitor bounded method-version distribution, unavailable reasons, confidence bands, source conflicts, recomputation age, queue lag, stale EV, and publication failures.
- Alert Engineering on recomputation backlog, method mismatch, publication rejection, and freshness expiry with deduplicatable bounded events.
- Exclude money values, raw source data, provider payloads, credentials, user identities, and protected evidence from logs and anonymous telemetry.
- Preserve public catalog availability when individual EV is unavailable or replacement publication is delayed.
- Record exact calculation, confidence, configuration, code, and release identities for each operational proof.

### Failure and rollback

- Exercise partial evidence, source conflict, stale data, invalid price, unsupported currency, ambiguous draws, overflow, recomputation failure, and malformed release projection.
- Leave the last coherent active release readable when replacement calculation or publication fails before activation.
- Prove expiry removes a result from ranking without converting it to zero or mutating immutable history.
- Run one maintenance-gated rollback that restores the prior application code and active release pointer before traffic resumes.
- Prove replay, refresh, retry, interruption, and recovery preserve revision identity and never expose a mixed-method page.

## User-Facing Behavior

Cutover either presents one coherent new release or leaves the prior application and release active. Users never see partially backfilled metrics, silently relabeled old values, or a broken catalog because one repack lacks evidence.

## Interface Contract

The operational ledger records candidate and prior identities, application commit, method and policy versions, canonical revision counts, public release ID, configuration hash, source-age distribution, unavailable reasons, maintenance timing, verification commands, alert evidence, promotion, and rollback result.

The readiness result is strict pass or blocked. A blocked result cannot waive a criterion or activate a mixed release.

## Acceptance Criteria

- [ ] Every active repack is recomputed or deterministically unavailable and all counts reconcile through the staged public release.
- [ ] No historical pre-buyback value is relabeled, selected, dual-read, dual-written, or mixed into the replacement contract.
- [ ] Monitoring and alerts cover versions, age, lag, conflicts, unavailability, and publication failure without leaking protected data.
- [ ] Failure, retry, expiry, replay, interruption, recovery, atomic activation, and coherent rollback drills pass.
- [ ] The release ledger contains complete reproducible evidence and remains blocked until every operational criterion passes.
