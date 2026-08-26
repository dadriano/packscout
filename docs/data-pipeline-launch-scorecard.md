# Data Pipeline Launch Scorecard

**Evidence date:** 2026-08-20

**DataForrest Events V1 transport gate:** PASS WITH 250-RECORD PAGE BOUND

**DataForrest V1 record gate:** PASS — current catalog, pull, and trade envelopes

**Aggregate V1 fixture and controllable-mock gate:** HISTORICAL ONLY — not a launch input

**Repository `npm run verify:framework` gate:** NOT YET RUN FOR THE CLEAN-SLATE V1 CUTOVER

**Real-provider deployment gate:** PARTIAL — live transport is proven; implementation, capacity preflight, and full backfill remain

## Current DataForrest Events V1 evidence

The authenticated read-only evidence package in
[`dataforest-events-v1-live-evidence.md`](./dataforest-events-v1-live-evidence.md)
supersedes the transport unknowns recorded below. It proves one profile-only
probe, four filtered initial/continuation/restart paths, cursor/filter isolation,
the `records` / `next_cursor` / `poll_after_seconds` wrapper, `payment_method`,
tri-state `available`, and a safe aggregate concurrency of two.

A 500-record Phygitals response exceeded the original 2 MiB capture cap, so the
page target remains 250 records. Later 250-record pages crossed the earlier
transport bounds; the sole current V1 adapter has an 8 MiB hard cap after a
protected replay measured the failing page at 4,730,013 bytes. The historical
8,759,332,238,475-byte Task 010 result is a maximum-throughput stress ceiling,
not the operational local estimate. Current local operation uses measured
whole-database growth plus an explicit free-space floor; see
[`provider-source-live-capacity-observation-2026-08-24.md`](./provider-source-live-capacity-observation-2026-08-24.md).

## Current launch boundary

DataForrest has one launch identity: source type `dataforrest-events-v1`, source
adapter `dataforrest-events-adapter-v1`, normalized observation
`packscout.provider-observation.v1`, and provider mapper revision `1`. The live
evidence supplies the request path, authentication shape, platform selector,
raw page wrapper, page-size behavior, opaque cursor, reached-head signal, and
record envelopes for catalog, pulls, and trades.

The current pull contract accepts authoritative pack-only and card-only records,
rejects a pull when both relationships are absent, and never fabricates the
missing edge. Provider-local display-name extraction is exact and has no
cross-field fallback. No compatibility adapter, dual read/write, adapter
upgrade, or source replacement is registered.

| Current launch evidence | Current state | Verdict |
| --- | --- | --- |
| Live request, wrapper, cursor isolation, and 250-record page target | Reviewed authenticated capture | PASS |
| Catalog, partial pull, and trade normalization under the exact V1 tuple | Contract and mapper tests | PASS |
| Sole adapter/observation/mapper runtime registration | Production registries and Task 010 fail-closed topology gate | PASS |
| Historical database-pin handling | Guarded full local reset and reimport; no in-place upgrade path | REQUIRED |
| 8 MiB maximum-page bounded-memory proof | Committed 100-page measurement and eight independent fresh-process repetitions passed unchanged gates | PASS |
| Full-history provider-head reconciliation | Requires the controlled local backfill | PENDING |

Everything below under the aggregate V1 fixture scorecard is retained as
historical PR #1 evidence for canonical history, quarantine, projections, and EV
behavior only. It is not permission to register `http-cursor-v1` for the launch
source or infer a second DataForrest runtime contract.

## Evidence boundary

This scorecard records local test evidence for all eight mapping-manifest platforms. The harness uses the supplied representative payload files, verifies their manifest-pinned SHA-256 hashes before parsing, and keeps their raw bytes outside the repository and test output. It then composes the production HTTP cursor adapter's non-importing connection path, generic feed contract, mapping registry, import-page planner, projection services, EV calculator, and a test-only controllable cursor endpoint and durable ledger.

The evidence is fixture/mock evidence only. It does not prove provider connectivity, real full-history completeness, real cursor behavior, persisted run/configuration IDs, deployment security, or production readiness. No bearer credential, raw payload, user identity, wallet, or account identifier is recorded here.

Fixture configuration and run IDs are `N/A`: the launch harness intentionally does not create database-backed configuration or run records. Its stable fixture labels are not deployment identities.

## Historical aggregate V1 fixture and mock scorecard

`C/P/S` means catalog/pull/sale source records. `Backfill C/R/U` means canonical projection commands that created, revised, or left unchanged a canonical identity during the initial page. Multiple projection commands may target one identity, so command count is reconciled to outcomes rather than assumed to equal the final unique-identity count. `Replay/correction/new` is source-version accounting for the incremental page.

| Platform | Mock connection | Source C/P/S | Mapped / quarantined | Projection commands | Backfill C/R/U | Canonical identities, initial → incremental | Incremental replay/correction/new | Incremental canonical C/R | EV estimated / unavailable | Fixture verdict |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Beezie | PASS | 4/15/15 | 34/0 | 257 | 257/0/0 | 257 → 258 | 1/1/1 | 1/1 | 4/0 | PASS |
| ClutchPacks | PASS | 14/15/15 | 44/0 | 1,206 | 951/255/0 | 951 → 952 | 1/1/1 | 1/1 | 6/8 | PASS |
| Collector Crypt | PASS | 14/15/15 | 44/0 | 331 | 288/43/0 | 288 → 289 | 1/1/1 | 1/1 | 7/0 | PASS |
| Courtyard | PASS | 11/15/15 | 41/0 | 299 | 285/14/0 | 285 → 286 | 1/1/1 | 1/1 | 4/4 | PASS |
| GameStop | PASS | 8/15/0 | 23/0 | 1,213 | 1,213/0/0 | 1,213 → 1,214 | 1/1/1 | 1/1 | 35/10 | PASS |
| Phygitals | PASS | 15/15/15 | 45/0 | 526 | 524/2/0 | 524 → 525 | 1/1/1 | 1/1 | 0/18 | PASS |
| Stadium Vault | PASS | 14/15/0 | 29/0 | 211 | 147/64/0 | 147 → 148 | 1/1/1 | 1/1 | 14/0 | PASS |
| Trove | PASS | 15/15/0 | 30/0 | 225 | 210/15/0 | 210 → 211 | 1/1/1 | 1/1 | 15/0 | PASS |
| **Total** | **8/8 PASS** | **95/120/75** | **290/0** | **4,268** | **3,875/393/0** | **3,875 → 3,883** | **8/8/8** | **8/8** | **85/40** | **PASS** |

The harness proves the following for every platform without a platform branch outside the mapper manifest:

1. The production HTTP cursor adapter performs a non-importing initial-page connection request for each platform, removes any configured cursor, sends the correct platform parameter, validates the response, and returns bounded counts.
2. The initial import request supplies no cursor and accepts every valid representative source record.
3. Reconstructing the runner around the same test ledger resumes from the previously committed fixture head.
4. An incremental page containing an exact replay, a changed version of the same pull, and a new pull identity yields one replay, one correction, one new source identity, one canonical revision, and one canonical creation.
5. A later mixed page keeps its valid replay moving while quarantining one malformed record. Across the eight platforms, eight malformed records are quarantined independently and all eight fixture cursors advance to the next safe head.
6. A response with `has_more: true` and a non-advancing cursor is rejected with `cursor_not_advanced` for every platform.
7. Every initial projection command is reconciled: 4,268 commands equal 3,875 canonical creations plus 393 same-page revisions plus zero unchanged writes.
8. Canonical evidence is fingerprinted deterministically, actor references use the HMAC pseudonymizer, and the captured canonical ledger is checked for raw identity field names.

The fixture cursor progression is `no cursor → fixture head v1 → fixture head v2 → fixture head v3`. These are test-only safe labels, not previews of provider cursors.

## EV availability evidence

EV totals count mapped EV inputs, not source records. A PackScout estimate appears only when the mapped distribution meets the supported calculation contract. Packs remain mappable when an estimate is unavailable.

| Platform | Unavailable count | Observed unavailable reasons |
| --- | ---: | --- |
| ClutchPacks | 8 | `incomplete_inventory`, `incomplete_probability_coverage` |
| Courtyard | 4 | `incomplete_inventory`, `missing_probability_buckets` |
| GameStop | 10 | `incomplete_probability_coverage` |
| Phygitals | 18 | `ambiguous_unit_basis`, `incomplete_inventory`, `incomplete_probability_coverage`, `invalid_draw_count` |

Beezie, Collector Crypt, Stadium Vault, and Trove have no unavailable EV result in the representative files. This is not evidence that an upstream full history contains no incomplete distribution.

## Controllable failure and recovery evidence

Each outcome below is exercised once per manifest platform through the same generic test-only transport sequence, for 32 scenario executions total.

| Mock condition | Normalized evidence | Expected final state | Attempts per platform | Executions |
| --- | --- | --- | ---: | ---: |
| HTTP 429 followed by a valid page | retryable `http_error` | recovered | 2 | 8 |
| Timeout followed by a valid page | retryable `timeout` | recovered | 2 | 8 |
| HTTP 401 | non-retryable `http_error` | failed closed | 1 | 8 |
| Cursor-safety contract failure | non-retryable `invalid_response` with `cursor_not_advanced` | failed closed | 1 | 8 |

This proves the generic retry decision in the launch harness. It does not claim that a real provider emitted or recovered from any of these conditions.

## Shared provider-neutral release evidence

The platform rows use the same shared runtime boundaries, so the following gates apply to every row without duplicating provider-specific orchestration. These checks complement the fixture harness; they do not convert mock evidence into real-provider evidence.

| Release concern | Committed evidence | Local verdict |
| --- | --- | --- |
| Empty sales, null relationships, unknown event types, nullable values, unsupported currencies, incomplete odds, and mapper drift | Provider mapper fixture and drift tests under `packages/services/src/providers` plus the table-driven EV calculator tests | PASS |
| Atomic page durability, restart resume, cursor safety, quarantine continuation, and immutable history | `provider-import-service.integration.test.ts`, `persistence.integration.test.ts`, and `quarantine-service.test.ts` | PASS |
| Late relationship reconciliation | Database and event-projection integration tests prove catalog arrival resolves older links atomically and repeated reconciliation is idempotent | PASS |
| Durable EV recomputation | Database queue and worker processor integration tests prove relevant input changes enqueue atomically, concurrent claims are disjoint, restarts recover leases, equivalent inputs deduplicate, and unavailable results persist | PASS |
| Five-minute scheduling, freshness, stale recovery, and independent quality state | Provider scheduling, worker runtime, provider health, and operational runtime tests | PASS |
| Ninety-day retention, alert deduplication, notification abstraction, and safe telemetry | Database operations, retention service/coordinator, operational events, alert service, and worker composition tests | PASS |
| Admin authentication, roles, secrets, provider lifecycle, manual conflicts, pagination, retries, and sanitized diagnostics | Admin auth/operator/provider/import/alert route tests plus the real admin-composition integration test | PASS |
| Operator interface | Admin component and route tests plus authenticated desktop and compact-width browser smoke covering navigation, dialogs, filters, focusable controls, and page-level overflow | PASS |

The durable EV row is valid only after the repository-wide gate recorded below passes with the final queue composition.

## Historical aggregate V1 real-provider deployment gate

| Platform | Endpoint/configuration | Connection test | No-cursor full history | Durable-head incremental | Real reconciliation | Launch state |
| --- | --- | --- | --- | --- | --- | --- |
| Beezie | Not configured | Not run | Not run | Not run | Not run | BLOCKED ON ENVIRONMENT |
| ClutchPacks | Not configured | Not run | Not run | Not run | Not run | BLOCKED ON ENVIRONMENT |
| Collector Crypt | Not configured | Not run | Not run | Not run | Not run | BLOCKED ON ENVIRONMENT |
| Courtyard | Not configured | Not run | Not run | Not run | Not run | BLOCKED ON ENVIRONMENT |
| GameStop | Not configured | Not run | Not run | Not run | Not run | BLOCKED ON ENVIRONMENT |
| Phygitals | Not configured | Not run | Not run | Not run | Not run | BLOCKED ON ENVIRONMENT |
| Stadium Vault | Not configured | Not run | Not run | Not run | Not run | BLOCKED ON ENVIRONMENT |
| Trove | Not configured | Not run | Not run | Not run | Not run | BLOCKED ON ENVIRONMENT |

## Exact remaining current-V1 environment and launch setup

1. Provision a PostgreSQL 16 deployment with current migrations and an organization containing the approved administrator and data-operator accounts.
2. Supply the admin and worker runtimes with `PACKSCOUT_DATABASE_URL`, distinct 32-byte base64 `PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64` and `PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64` values, the worker's `PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION`, and the admin's `PACKSCOUT_SESSION_HASHING_SECRET`. Set `PACKSCOUT_ADMIN_TRUSTED_PROXIES` to the exact comma-separated proxy IP addresses or CIDR ranges when the admin runs behind a reverse proxy; leave it unset for a direct connection so forwarded client-address headers remain untrusted. Set `PACKSCOUT_ESTIMATED_EV_VERIFIED_USD_STABLECOINS` only after financial/data approval, using a comma-separated allowlist of uppercase 2–12 character currency identifiers (maximum 32; no `USD`, duplicates, spaces, or lowercase); unset or empty trusts no stablecoins. Supply normal runtime origin, session, worker identity, pool, and polling settings for the target environment. Secrets must stay in deployment secret storage and out of commands, logs, screenshots, and this scorecard.
3. Stop local admin and worker runtimes and follow the [local reset and first-administrator bootstrap](local-development-first-admin-bootstrap.md): run `npm run db:reset:local`, then the guarded `npm run db:bootstrap-first-admin:local` stdin-secret workflow. This is a full relational reset and canonical reseed, not a selective provider-data delete. Recreate and test the encrypted DataForrest connection and all four current v1 source revisions afterward.
4. Create and test one connection and four sources. Verify every immutable diagnostic pin is the exact current source-adapter/observation/mapper tuple before activation.
5. Run the dedicated Task 010 topology checks. Any historical or mixed tuple must fail closed; cursor reset, adapter upgrade, and source replacement are not reset substitutes.
6. Begin Task 010 at the dedicated runner's reviewed one-execution-slot setting. The 8 MiB measurement passes the unchanged 64 MiB peak and 8 MiB retained-growth gates; any concurrency increase requires its own reviewed measurement.
7. Backfill each source to its evidenced terminal state, restart from every source cursor, and verify that only the source whose validated page commits advances.
8. Run real incrementals with an exact event replay, a conflicting pull/trade repeat, a catalog correction, a malformed record, timeout, rate limit, authentication failure, stale/recovery, and lost-worker recovery. Reconcile accepted, duplicate, quarantined, canonical-revision, Estimated EV, unavailable, and exported counts using only sanitized stable evidence.
9. Resolve every real count difference and define numeric release thresholds for quarantine rate and unresolved relationships. Run the focused V1 checks and `npm run verify:framework`; Product and Engineering owners must review the persisted evidence before enabling incremental schedules or labeling the public catalog live.

## Reproducing the fixture evidence

The representative files are intentionally external to the repository. Point the test at the approved directory; if the files are absent, the sample-dependent test reports a skip rather than manufacturing evidence.

```bash
PACKSCOUT_PROVIDER_SAMPLES=/absolute/path/to/approved/provider-samples \
  node --import tsx --test \
  packages/services/src/providers/provider-launch-harness.test.ts
```

The focused verification for this scorecard is:

```bash
npm run lint --workspace=@packscout/services
npm run typecheck --workspace=@packscout/services
PACKSCOUT_PROVIDER_SAMPLES=/absolute/path/to/approved/provider-samples \
  node --import tsx --test \
  packages/services/src/providers/provider-launch-harness.test.ts
```

The integrated `npm run verify:framework` run recorded on 2026-08-06 applies to
the historical aggregate fixture implementation only. A fresh repository-wide
run is required after the clean-slate V1 cutover.
