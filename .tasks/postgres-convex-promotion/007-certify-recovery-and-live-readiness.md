# Task: Certify Recovery and Live Readiness

**ID:** postgres-convex-promotion/007
**Depends on:** postgres-convex-promotion/004, postgres-convex-promotion/006
**Blocks:** none
**Estimated scope:** large
**Estimated effort:** 2–4 days for one builder, including end-to-end and failure-injection evidence
**Status:** todo

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

- [ ] Production startup rejects missing/unsafe organization, deployment, signing, timing, or batch configuration.
- [ ] Initial backfill and later delayed-provider scenarios produce the resolved readiness and freshness behavior.
- [ ] Full rebuild and incremental publication at the same settled state have identical public hashes and counts.
- [ ] Restart, replay, lost-acknowledgement, network retry, and stale-claim scenarios terminate without duplicate or regressed public data.
- [ ] Contract/auth/hash/block failures leave the prior complete release active and produce safe terminal evidence and alerts.
- [ ] Rollback/clear, key rotation, retention, and bounded cleanup preserve pointer and manifest-block safety.
- [ ] Catalog and Heat meet their normal one-minute targets at representative volume; misaligned or 15-minute-stale Heat fails closed without blocking catalog.
- [ ] The operational runbook and reproducible evidence contain no secret, tenant, raw payload, actor, or quarantine detail.
- [ ] `npm run verify:framework` passes on the integrated branch.

## Verification

`npm run verify:framework`
