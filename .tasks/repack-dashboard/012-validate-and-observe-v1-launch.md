# Task: Validate and Observe the V1 Launch

**ID:** repack-dashboard/012
**Depends on:** repack-dashboard/001, repack-dashboard/002, repack-dashboard/003, repack-dashboard/004, repack-dashboard/005, repack-dashboard/006, repack-dashboard/007, repack-dashboard/008, repack-dashboard/009, repack-dashboard/010, repack-dashboard/011
**Blocks:** none
**Estimated scope:** large
**Estimated effort:** 7–10 days for one builder, including instrumentation, preproduction evidence, recovery drills, and full verification
**Status:** blocked

## Start Here

Run one sanitized preproduction catalog snapshot from real provider pages through Overview and All Packs, then reconcile source, canonical, snapshot, query, and rendered counts.

## Objective

Prove the complete V1 flow with real preproduction data, privacy-safe outcome signals, failure observability, and recorded launch/rollback evidence before calling PackScout live.

## Context

The data-pipeline PR’s current scorecard passes fixtures and controllable mocks but explicitly has not run real provider endpoints, full histories, or incrementals. Frontend completion requires more than a successful build: the public snapshot, query behavior, outbound tracking, accessibility, performance, and stale recovery must all be evidenced together.

## Requirements

### Anonymous Product Signals

- Record `dashboard_view`, `catalog_search`, `filters_applied`, `promo_copied`, and `pack_link_opened` as aggregate outcomes.
- Include snapshot version and the event-specific outcome on every event; include public pack ID and platform key only for Promo/Pack Link subject events and omit them otherwise.
- Do not block promo or outbound actions when telemetry delivery fails.
- Deduplicate retried server events by stable idempotency key for a 24-hour replay window.
- Reject event fields outside the approved schema rather than persisting arbitrary browser metadata.

### Product Signal Contract

Every event also requires schema version `anonymous-product-event-v1`, UUID event ID, retained complete snapshot version, and UTC occurred-at time.

| Event | Exact event-specific fields |
|---|---|
| `dashboard_view` | Surface `overview` or `all_packs`; outcome `rendered`; no pack/platform fields |
| `catalog_search` | `surface: "all_packs"`; `outcome: "results" \| "no_matches" \| "failed"`; `queryLengthBucket: "1-20" \| "21-60" \| "61-120"`; `resultCountBucket: "0" \| "1-25" \| "26-100" \| "101+"`; no raw query or pack/platform |
| `filters_applied` | `surface: "overview" \| "all_packs"`; the same exact result outcome/count buckets; `activeFilterCount: 0 \| 1 \| 2 \| 3`; no pack/platform |
| `promo_copied` | Required `publicPackId`/`platformKey`; `outcome: "clipboard" \| "manual_fallback" \| "failed"` |
| `pack_link_opened` | Required `publicPackId`/`platformKey`; `outcome: "opened" \| "blocked"` |

### Telemetry Boundary and Abuse Controls

- Require exact configured `Origin`, `Sec-Fetch-Site: same-origin`, `application/json`, absent/`identity` `Content-Encoding`, and one strict JSON object with no extra keys.
- Reject declared or actual UTF-8 bodies above 4,096 bytes before parsing; require UUID IDs and UTC times no more than five minutes old or one minute future.
- Validate the active or safe previous complete snapshot and, when applicable, its public pack/platform pair through the bounded Convex validation query; reject subject fields on non-subject events.
- Require an edge limit of 60 requests/minute/source with burst 20; keep its key only in edge memory for two minutes and never forward or log it in the app.
- Enforce a separate atomic database circuit breaker of 5,000 combined telemetry/public-read-failure writes per environment/minute with no source identity.

### Product Signal Lifecycle

- Retain event-level anonymous product signals for a hard maximum of 30 days; do not extend the limit for aggregation failure.
- Retain daily aggregate counts for 13 months, then delete them through a bounded retention job.
- Aggregate at most 500 rows transactionally; at ten failures or the 30-day cutoff, atomically increment a coarse day/event/failure dead-letter count and delete the raw row, retaining no event ID, snapshot, pack, platform, query, or network field.
- Restrict audited raw reads to Engineering operations for at most seven days/request; allow Product and Engineering owners to read daily aggregates only.
- Prove crash rollback, committed replay, concurrent-worker exclusion, hard-cutoff dead-letter/delete behavior, incomplete-day alerting, retention counts, and access policy.

### Operational Signals

- Add post-PR `packages/services/src/public-catalog-observability-service.ts`, `packages/database/src/public-observability-repository.ts` plus `schema/public-observability.ts`, and `apps/worker/src/public-catalog-observability.ts`; reuse existing operational event/alert services for publication-ledger, reconciliation, observation-age, delayed-source, and read outcomes.
- Record server-preload successes/failures for a denominator; alert at a five-minute failure rate of at least 5% with at least 20 attempts.
- Accept client reactive failures only through strict same-origin `POST /api/public-read-failure`: allow the four public query names, five route surfaces, five stable failure codes, nullable retained snapshot version, and retained-result flag defined in `repack-dashboard/tech-004`; reject raw query, cursor, pack, and platform fields.
- Alert when no complete snapshot/observation exists, successful-observation age reaches 30 minutes, or reconciliation fails; report reactive failure volume separately.
- Keep public copy sanitized, prove failed publication retains the prior complete snapshot, and prove changed activation or unchanged metadata-only reconciliation clears age-based delay after recovery.

### Freshness Policy

- Treat the catalog as fresh while `now - catalogState.lastSuccessfulObservationAt <= 15 minutes` unless source metadata already reports a delayed input.
- Atomically refresh `lastSuccessfulObservationAt` after every successful reconciliation, including a metadata-only refresh when canonical content is unchanged; do not mint or rewrite an immutable snapshot for that unchanged result.
- Show delayed status immediately for a delayed input or above 15 minutes since the last successful observation; failed reconciliation does not advance the timestamp.
- Alert the Engineering owner when no complete snapshot/observation exists or successful-observation age reaches 30 minutes.
- Keep the last complete content readable during delay and clear age-based delay/alert after a successful reconciliation when no source remains delayed; age alone never invents unavailable pack values.

### Performance Targets

- Target a 75th-percentile Largest Contentful Paint at or below 2.5 seconds on supported production mobile traffic.
- Show immediate local feedback for search/filter submission and target refreshed results within one second on the representative launch catalog.
- Keep catalog reads bounded by documented row and byte limits at 1,500 and 10,000 public pack fixtures.
- Prevent unbounded image, query, pagination, and telemetry payloads.
- Record measured results and the environment used rather than claiming unmeasured performance.

### Executable Browser and Performance Evidence

- Add `@playwright/test`, `apps/frontend/playwright.config.ts`, and `apps/frontend/e2e/repack-dashboard.spec.ts` with traces, screenshots, and HTML reports.
- Provide `scripts/local/run-repack-dashboard-browser.mjs` and `scripts/preproduction/run-repack-dashboard-browser.mjs` behind guarded `test:browser:frontend:local` and `test:browser:frontend:preproduction` commands for the exact viewport/theme/comp projects.
- Provide `scripts/local/repack-dashboard-performance.mjs` and `scripts/preproduction/repack-dashboard-performance.mjs` behind guarded `test:catalog-performance:local` and `test:catalog-performance:preproduction` commands for deterministic 1,500/10,000-pack evidence.
- Local scripts accept only localhost/127.0.0.1; preproduction scripts require its exact HTTPS origin and refuse the configured live origin.
- Keep all four environment-aware commands separate from `npm test`, then run them explicitly after the canonical verifier for launch evidence.

### Preproduction Launch Gate

- Run real no-cursor history and durable incremental imports for each launch stream.
- Reconcile accepted, quarantined, canonical, estimated/unavailable, published, searchable, and rendered counts.
- Verify the neutral placeholder for missing/failed pack images, text-only missing/failed chase images, approved referral/promo behavior, and equality of the frontend/Convex expected origin-set hash with the snapshot manifest without completing a purchase.
- Complete focused automated checks, browser smoke, and the canonical repository verification gate.
- Obtain joint Product-owner and Engineering-owner approval of sanitized evidence before enabling live data labels.

### Launch Ownership

- Product owns partner copy, metric education, and the decision to expose the live label.
- Engineering owns provider-contract evidence, publication safety, performance evidence, and rollback execution.
- Both owners sign the same immutable evidence manifest containing environment, commit, snapshot, and test identifiers.
- A missing owner approval keeps the public surface in preproduction labeling.
- Approval never substitutes for failed automated, reconciliation, security, or real-provider gates.

### Recovery and Rollback

- Demonstrate confirmed audited activation of a reconciled, complete, unblocked previous snapshot without changing canonical history; the unsafe outgoing snapshot becomes blocked and never becomes previous.
- Demonstrate a full snapshot rebuild from canonical data only after the authoritative PostgreSQL manifest-block set is synchronized and hash-reconciled into Convex.
- Keep rollback free of user-data migration because V1 stores no account state.
- Record the exact trigger, owner, and evidence for rollback and reactivation.
- Keep failed staged snapshots unavailable and prove the unsafe outgoing manifest fingerprint cannot republish under a new publication ID.

### Rollback Triggers

- The Engineering owner immediately reactivates the previous complete snapshot after a count/hash mismatch, public data leak, incorrect EV formula/version, or broken outbound-host policy is confirmed.
- A publication or query failure without unsafe active data keeps the current complete snapshot and enters delayed mode instead of rolling back automatically.
- Rollback validates the stored previous pointer and immutable manifest, requires typed confirmation plus an idempotency key, blocks the unsafe outgoing snapshot, and never edits canonical PostgreSQL history.
- Product and Engineering owners review the recovery evidence before a corrected snapshot restores live labeling.
- If no safe previous snapshot exists, an explicitly confirmed clear removes the active pointer so Dashboard enters initial-unavailable state while Learn remains public.

## User-Facing Behavior

Users receive a fast, anonymous, current Dashboard whose public status matches real snapshot health. Product analytics never interrupt comparison or outbound partner actions.

## Interface Contract

The launch evidence bundle contains:

| Evidence group | Required proof |
|---|---|
| Data | Real stream contract, backfill/incremental runs, count reconciliation, unavailable reasons |
| Snapshot | Idempotency, active/previous versions, stale/recovery, full rebuild |
| Product | Overview, All Packs, inspector, promo, Pack Link, Learn, state recovery |
| Quality | Automated checks, accessibility, required browser viewports/themes, performance measurements |
| Operations | Anonymous event schema, failure metrics, alert owner, rollback record |

## Acceptance Criteria

### Launch Evidence

- [ ] Real preproduction pages pass the approved stream contract and complete backfill plus incremental flows.
- [ ] Canonical, snapshot, query, and rendered counts reconcile with explained exclusions.
- [ ] Every V1 user flow passes automated or explicitly owned manual coverage.
- [ ] Required browser, accessibility, performance, and repository verification evidence is recorded.
- [ ] Product and Engineering owners approve the sanitized launch bundle before live labeling.

### Observability and Recovery Evidence

- [x] Five anonymous product outcomes contain no persistent user, tenant, wallet, or credential data.
- [x] Telemetry failure never blocks promo copy or outbound navigation.
- [ ] Publication failure, stale mode, recovery, previous-snapshot activation, and full rebuild are demonstrated.
- [ ] Internal diagnostics remain useful while public failure copy stays sanitized.
- [x] No task, test, or document claims real-provider readiness before this gate passes.

### Policy Evidence

- [ ] Fresh, delayed, 30-minute alert, recovery, and no-safe-snapshot states use `catalogState.lastSuccessfulObservationAt`, including unchanged metadata-only refresh and failed-reconciliation non-advance behavior.
- [ ] Telemetry replay deduplication expires after 24 hours without accepting duplicate events inside the window.
- [ ] Event-level and daily aggregate retention complete at 30 days and 13 months with role-restricted access.
- [ ] Every approved rollback trigger activates only a reconciled safe snapshot or explicitly clears availability, while the outgoing manifest fingerprint remains blocked across a new publication ID.
- [ ] Joint launch and post-rollback approvals are recorded against one immutable evidence manifest.

### Telemetry, Observability, and Automation Evidence

- [ ] Every discriminated event rejects forbidden fields, invalid subject context, cross-origin/fetch-metadata/media/time/size failures, and both limit breaches.
- [ ] Aggregation remains exact after crash/replay/concurrency; failed rows become only coarse dead-letter counts and no event-level row survives 30 days.
- [ ] Engineering-only raw access and Product/Engineering aggregate access pass direct authorization and audit tests.
- [ ] Server preload rate, reactive failure beacons, successful-observation age, reconciliation, alert, and recovery paths execute through the named service/repository/worker.
- [ ] Guarded local and preproduction Playwright/performance commands run separately from `npm test` and record their scoped artifacts.

## Build Status

- Implemented locally: strict five-event anonymous product contracts; query-length/result-count buckets with no raw search; nonblocking beacon/fetch delivery; strict same-origin telemetry and public-read-failure route validation; subject/snapshot context checks; bounded payload/time/media schemas; a shared stable circuit-breaker response vocabulary; nonce/exact-origin CSP; and pathname-only application logging.
- Verified locally: telemetry contract/client/route and public-read-failure behavior tests cover unknown fields, subject rules, Origin/fetch metadata, media/encoding, UTF-8 size, event time, context, duplicate vocabulary, and caller-nonblocking delivery. Security policy, request-log, frontend test/build, and local browser checks recorded green.
- Blocked: there is no durable PostgreSQL telemetry/receipt/aggregate/dead-letter/retention store, edge 60/minute burst-20 enforcement, operational service/repository/worker, real server-preload denominator/alerts, or access/audit implementation. Real 1,500/10,000 scale, Playwright/preproduction/performance/LCP artifacts, provider reconciliation, rollback/rebuild drills, query-string edge-log proof, and Product/Engineering approvals do not exist.

## Spec Compliance

- Related specs reviewed: repack-dashboard/tech-001, repack-dashboard/tech-002, repack-dashboard/tech-003, repack-dashboard/tech-004, repack-dashboard/ux-001, repack-dashboard/ux-002, repack-dashboard/ux-003, repack-dashboard/ux-004, repack-dashboard/ux-005
- Alignment: the completed frontend-only security, telemetry DTO/request, nonblocking action, CSP, and log-sanitization slices follow the exact bounded public contracts without persistent browser identity or raw catalog state.
- Divergences: route-local adapters intentionally do not claim the durable analytics/observability lifecycle, edge limiter, cloud/publication monitoring, launch harness, or owner approval required by the spec.
- Verification: focused frontend security/telemetry/public-read tests, typecheck/lint/build, framework verification, and local browser smoke are recorded; every real-provider, durability, scale, preproduction, performance, recovery, and approval gate remains unverified.
