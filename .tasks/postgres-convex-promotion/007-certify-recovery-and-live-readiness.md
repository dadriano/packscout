# Task: Certify Recovery and Live Readiness

**ID:** postgres-convex-promotion/007
**Depends on:** postgres-convex-promotion/004, postgres-convex-promotion/006
**Blocks:** none
**Estimated scope:** large
**Estimated effort:** 2–4 days for one builder, including end-to-end and failure-injection evidence
**Status:** blocked

## Start Here

Run the initial-backfill scenario end to end with a local PostgreSQL database and fake or local Convex deployment, then capture the active release hash, settled watermark, publication receipt, and aligned Heat frame as the first evidence checkpoint.

## Objective

Prove the promotion system can launch, recover, reconcile, retain, and fail safely under the operational conditions PackScout will encounter.

## Context

Individual persistence, assembler, runner, and Convex tests are insufficient for a canonical publication boundary. Launch requires evidence that the same authoritative state produces the same public release, ambiguous failures recover without duplication, prior data remains safe, and independent Heat expiry behaves correctly.

## Requirements

- Provide a production configuration contract for the approved organization, Convex deployment URL, active signing key ID/secret, request timeout, polling cadence, lease/backoff limits, batch limits, and alert thresholds.
- Validate required settings at startup with stable errors; production cannot silently disable authentication, select a tenant from input, or use mock data.
- Emit structured, non-secret observability for settlement lag, requested/activated watermarks, publication age/state, retries, reconciliation mismatches, delayed vendors, Heat frame age/alignment, expiry, and terminal failures.
- Alert when a settled catalog normally fails to activate within one minute, when technical derivation blocks settlement, when publication reconciliation fails, and before/when Heat becomes unavailable.
- Prove initial activation refuses incomplete enabled-provider backfill or unsettled derivations and succeeds when both are complete.
- Prove a later delayed provider preserves its last settled values and reports the delayed count.
- Prove full rebuild, incremental promotion, restart resume, exact replay, lost acknowledgements, hash/count mismatch, blocked manifest, rollback/clear, key rotation, stale nonce, and retention behavior.
- Prove the previous complete catalog stays readable through every failed staged publication and catalog/Heat failure combination.
- Prove active/previous retention, additional-release limits, abandoned-stage cleanup, and bounded deletion without dangling documents or pointers.
- Prove the p95 one-minute catalog target and one-minute Heat cadence under representative volume without exceeding Convex batch limits.
- Preserve a documented operational runbook for backfill/enablement, key rotation, retry/reconciliation, rollback, unblock authority, retention, and safe shutdown.
- Run the repository's canonical framework verification gate before handoff.

## User-Facing Behavior

The first live catalog appears only after complete, settled canonical readiness. During later failures, users keep the previous complete catalog; freshness becomes delayed, and Heat independently expires to unavailable rather than showing stale or misaligned activity.

## Interface Contract

The launch evidence records, without secrets or protected source data:

- canonical input fixture/version and approved organization mapping;
- settled/requested/activated watermarks and exact catalog content hash/counts;
- PostgreSQL attempt IDs and authenticated Convex terminal receipt digests;
- previous/active pointer results across failure and rollback scenarios;
- Heat frame catalog alignment, watermark, hash/counts, and expiry result;
- timing/volume results and the commands used to reproduce them.

The runbook names only protected operator actions and stable outcomes; it does not expose key material or provider payloads.

## Acceptance Criteria

- [x] Production startup rejects missing/unsafe organization, deployment, signing, timing, or batch configuration.
- [x] Initial backfill and later delayed-provider scenarios produce the resolved readiness and freshness behavior.
- [x] Full rebuild and incremental publication at the same settled state have identical public hashes and counts.
- [x] Restart, replay, lost-acknowledgement, network retry, and stale-claim scenarios terminate without duplicate or regressed public data.
- [x] Contract/auth/hash/block failures leave the prior complete release active and produce safe terminal evidence and alerts.
- [ ] Rollback/clear, key rotation, retention, and bounded cleanup preserve pointer and manifest-block safety.
- [ ] Catalog and Heat meet their normal one-minute targets at representative volume; misaligned or 15-minute-stale Heat fails closed without blocking catalog.
- [x] The operational runbook and reproducible evidence contain no secret, tenant, raw payload, actor, or quarantine detail.
- [x] `npm run verify:framework` passes on the integrated branch.

## Verification

`npm run verify:framework`

## Completed Evidence

- The integrated local suites cover deterministic full/incremental assembly, initial and delayed-provider readiness, exact-byte restart/status recovery, stale claims, ambiguous signed responses, pointer safety, rollback/clear, nonce replay, bounded catalog/Heat retention, and 15-minute Heat expiry.
- Durable alerts are scoped by organization, a one-way deployment digest, and lane. They cover activation delay, technical settlement blocks, terminal/reconciliation failures, and cross-restart recovery without storing secrets or deployment keys.
- The protocol-maximum local catalog fixture completed preparation within one minute, and the 8,000-repack Heat fixture completed all 252 operations in one cycle. These are local/fake-transport diagnostics only.
- The operational runbook records the exact configuration, recovery, retention, rollback, clear, rotation, shutdown, evidence-redaction, and launch-gate procedures.

## Blocked

The remaining acceptance evidence requires a configured target environment and operator authority that this build does not have:

- Measure settled-to-confirmed catalog and Heat p50/p95/max/error results at representative volume against preproduction PostgreSQL and hosted Convex.
- Rehearse overlapping signing-key rotation, rollback, and retention through the target secret manager and authenticated deployment, then retire the old key only after the documented overlap.
- Configure and fire an external worker-liveness/no-advancing-Heat monitor before the 15-minute expiry boundary; an in-process worker cannot alert while its process is down.
- Execute the approved legacy Heat data reset/migration before deploying the incompatible production Heat schema. No compatibility shim or destructive live action is authorized by this task.
