# Data Pipeline Launch Scorecard

**Evidence date:** 2026-08-20

**DataForrest Events V1 transport gate:** PASS WITH 250-RECORD PAGE BOUND

**ProviderStreamContractV2 record gate:** PARTIAL PASS — real record envelopes only

**Aggregate V1 fixture and controllable-mock gate:** HISTORICAL ONLY — not a launch input

**Repository `npm run verify:framework` gate:** NOT RUN FOR V2

**Real-provider deployment gate:** PARTIAL — live transport is proven; implementation, capacity preflight, and full backfill remain

## Current DataForrest Events V1 evidence

The authenticated read-only evidence package in
[`dataforest-events-v1-live-evidence.md`](./dataforest-events-v1-live-evidence.md)
supersedes the transport unknowns recorded below. It proves one profile-only
probe, four filtered initial/continuation/restart paths, cursor/filter isolation,
the `records` / `next_cursor` / `poll_after_seconds` wrapper, `payment_method`,
tri-state `available`, and a safe aggregate concurrency of two.

A 500-record Phygitals response exceeded the 2 MiB safety cap, so the launch
page target is 250 records. The actual full-history import remains blocked until
the target volume has at least **8,759,332,238,475 available bytes**, as required
by the final-schema artifact. The former 200 GB provisional floor is
superseded. Operators must run
`npm run preflight:provider-source-backfill:local -- --database-path <postgres-data-volume-path> --unreconciled-attempts <count>`;
the reviewed local volume is explicitly rejected.

## Current launch boundary

`ProviderStreamContractV2` replaces the unlaunched aggregate
`ProviderFeedPageV1` boundary for the dashboard launch source. The provider draft
supplies real record-level examples for `catalog`, `pulls`, and `trades`; those
examples support the V2 discriminated record contract, required outer
relationships, nullable event time and money, catalog mutability, event
immutability, lifecycle vocabulary, and currency-reference evidence.

The draft does **not** supply request paths, authentication, stream selector,
raw page wrappers, page-size behavior, cursor fields, termination, ordering,
expiry, error envelopes, or rate-limit signals. No provider-local decoder,
runtime registration, durable cursor migration, backfill, or incremental
launch claim may be approved until sanitized real evidence locks those facts.

| V2 launch evidence | Current state | Verdict |
| --- | --- | --- |
| Real sanitized record envelope: catalog pack/card | Committed record-level fixture and contract test | PARTIAL PASS |
| Real sanitized record envelope: pull | Committed record-level fixture and contract test | PARTIAL PASS |
| Real sanitized record envelope: trade | Committed record-level fixture and contract test | PARTIAL PASS |
| Request path/auth/selector and raw page wrapper | Not supplied | BLOCKED |
| Independent cursor scope, termination, ordering, expiry, and full-history start | Not supplied | BLOCKED |
| Provider error and rate-limit behavior | Not supplied | BLOCKED |
| Per-stream durable cursor/restart and real reconciliation | Cannot run before transport evidence | BLOCKED |

Everything below under the aggregate V1 fixture scorecard is retained as
historical PR #1 evidence for canonical history, quarantine, projections, and EV
behavior only. It is not permission to register `http-cursor-v1` for the launch
source, infer a V2 page wrapper, or run V1 and V2 against the same source.

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

## Exact remaining V2 environment and launch setup

1. Provision a PostgreSQL 16 deployment with current migrations and an organization containing the approved administrator and data-operator accounts.
2. Supply the admin and worker runtimes with `PACKSCOUT_DATABASE_URL`, distinct 32-byte base64 `PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64` and `PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64` values, the worker's `PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION`, and the admin's `PACKSCOUT_SESSION_HASHING_SECRET`. Set `PACKSCOUT_ADMIN_TRUSTED_PROXIES` to the exact comma-separated proxy IP addresses or CIDR ranges when the admin runs behind a reverse proxy; leave it unset for a direct connection so forwarded client-address headers remain untrusted. Set `PACKSCOUT_ESTIMATED_EV_VERIFIED_USD_STABLECOINS` only after financial/data approval, using a comma-separated allowlist of uppercase 2–12 character currency identifiers (maximum 32; no `USD`, duplicates, spaces, or lowercase); unset or empty trusts no stablecoins. Supply normal runtime origin, session, worker identity, pool, and polling settings for the target environment. Secrets must stay in deployment secret storage and out of commands, logs, screenshots, and this scorecard.
3. Obtain and sanitize one real raw page for each of `catalog`, `pulls`, and `trades`. Record the exact request path, authentication method, stream selector, page-size behavior, raw wrapper, cursor field, end signal, error envelope, and rate-limit signals without recording a credential.
4. Confirm from provider evidence whether each stream has an independent cursor. Record ordering, cursor expiry, null-cursor full-history behavior, incremental continuation, and catalog correction delivery. If cursor scope differs from the V2 design, stop and revise the contract rather than silently reinterpreting it.
5. Implement and register one provider-local V2 transport decoder using the observed wrapper. Remove the launch source's aggregate V1 runtime registration, fixtures, and adapter selection in the same cutover; do not introduce aliases, dual reads, or a provider-name branch in generic orchestration.
6. Migrate unlaunched persistence to one durable cursor and run per `(configuration revision, stream)`. In preproduction, backfill each stream to its evidenced terminal state, restart from every stream cursor, and verify that only the stream whose validated page commits advances.
7. Run real incrementals with an exact event replay, a conflicting pull/trade repeat, a catalog correction, a malformed record, timeout, rate limit, authentication failure, stale/recovery, and lost-worker recovery. Reconcile accepted, duplicate, quarantined, canonical-revision, Estimated EV, unavailable, and exported counts using only sanitized stable evidence.
8. Resolve every real count difference and define numeric release thresholds for quarantine rate and unresolved relationships. Run the focused V2 checks and `npm run verify:framework`; Product and Engineering owners must review the persisted evidence before enabling incremental schedules or labeling the public catalog live.

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
the historical aggregate V1 fixture implementation only. It does not satisfy
the V2 gate above. A fresh repository-wide run is required after the V2 cutover.
