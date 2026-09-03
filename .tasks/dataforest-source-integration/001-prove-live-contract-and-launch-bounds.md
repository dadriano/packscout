# Task: Prove the Live Contract and Launch Bounds

**ID:** dataforest-source-integration/001
**Depends on:** none
**Blocks:** dataforest-source-integration/002
**Estimated scope:** medium
**Estimated effort:** 1–2 days for one builder, including sanitized live evidence, bounded concurrency evidence, storage modeling, and review
**Status:** done

## Start Here

Make one authenticated read-only Courtyard request with a small limit, keep the response only in a protected temporary location, and produce a sanitized structural fixture plus recorded byte and latency measurements.

## Objective

Answer one bounded research question: does the live DataForrest endpoint support the identity, page, cursor, response, and safe-parallelism evidence required to implement it as one source adapter behind four independent PackScout source instances?

## Context

The supplied endpoint is `https://198.204.245.26.sslip.io/v1/events`. Its guide contains a bearer key that must never enter this plan, source control, test output, logs, shell arguments, or browser responses. The guide describes one records page, an opaque `next_cursor`, and `poll_after_seconds`; it also reports roughly 14.5 million historical records across the four launch platforms.

Earlier PackScout plans assumed aggregate catalog/pulls/sales pages or separate stream cursors. Those shapes are obsolete. Later tasks must use authenticated evidence rather than inventing request parameters, nullability, error envelopes, or parallel-request behavior.

## Requirements

### Transport evidence

- Capture one task-002-compatible profile-only connection probe that requires no provider, filter, cursor, source, run, or page state, plus sanitized initial and continuation evidence for exact filters `courtyard`, `collector_crypt`, `phygitals`, and `clutchpacks`.
- Prove a saved cursor resumes after client restart with the same filter and cannot be moved to another provider filter.
- Record the common fields, catalog, pull, and trade fields, nullability, stream values, ordering observations, empty-page behavior, and documented head signal.
- Record authentication, validation, malformed-cursor, unknown-filter, timeout, server-error, and naturally observed rate-limit behavior without manufacturing harmful load.
- Classify each contract fact as live observed, provider documented, or still unavailable; unavailable facts cannot be silently guessed by a later task.

### Parallel and request bounds

- Obtain provider approval or safe bounded evidence for cross-platform overlap and record the provider's exact per-platform hard maximum separately from PackScout's operating concurrency.
- Verify that parallel requests return filter-correct records and independent cursors without cross-request contamination.
- Record a launch page target, maximum response bytes, request timeout, redirect and destination policy, and retry classification supported by the evidence.
- Use 500 records, 2 MiB, and 10 seconds as the approved defaults when evidence does not require a stricter value.
- Block task 002 for design review if fewer than two requests can safely overlap or the live topology contradicts independent platform cursors.

### Identity and adapter evidence

- Determine and freeze each provider record shape's `recordIdScopeKey`, including whether the same raw `record_id` may legitimately occur in catalog-pack, catalog-card, pull, or trade scopes; never assume provider-global uniqueness from a sample.
- Prove `record_id` is stable within that scope across continuation, replay, and collection time, and record its provider-specific replacement identity namespace without retaining actual identities.
- Prove records never cross the requested provider filter and every relationship ID has an unambiguous target record-ID scope in the provider namespace expected by the platform mapper.
- Record the exact raw-to-normalized translation for record kind, timestamps, relationships, event type, currency, payment method, availability, cursor, and continuation without applying canonical platform rules.
- Block task 002 for canonical-identity review if DataForrest cannot supply stable provider record IDs, the raw page cannot map deterministically to the fixed normalized observation contract, or two required launch record-ID scopes would map to the same canonical kind.

### Resource and retention evidence

- Measure sanitized page bytes, request latency, and records per second without treating the provider's one-to-two-hour download statement as a PackScout end-to-end guarantee.
- Model storage for full normalized history, indexes, one seven-day authoritative raw-page copy, 30-day quarantine evidence, 30-day processor diagnostics and terminal request attempts, plus permanent compact attempt lineage.
- Verify that normal accepted records do not require a second complete raw payload copy and that quarantined records retain independently retryable evidence.
- Define a representative storage and memory measurement that task 006 must run before the full backfill; memory must remain bounded by page size rather than total history.
- Record the dated aggregate counts as plausibility context rather than an exact per-provider acceptance total.

### Credential evidence

- Load the evidence-only token from an ignored local secret and remove protected temporary responses through the approved secure workflow after review.
- Confirm that the persistent runtime credential enters PackScout once through the existing encrypted administrator workflow, is represented elsewhere only by masked state and immutable revision references, and replaces the evidence-only local token before imports start.
- Sanitize authorization headers, credentials, cursors, provider record identities, transaction identities, wallets, usernames, and proprietary nested values from committed fixtures.
- Preserve field names, types, nesting, discriminators, nulls, and cursor relationships needed for deterministic contract tests.
- Record evidence date, endpoint identity, filters, limits, sanitization method, reviewer, and fixture hashes.

## User-Facing Behavior

None. This task prevents an unsafe or invented live-feed contract from reaching ingestion and the admin console.

## Interface Contract

This task delivers one reviewed evidence package:

| Artifact | Required result |
|---|---|
| Request contract | Exact profile-only connection probe plus filtered source-test and page-read method, path, bearer placement, cursor, limit, timeout, response bound, and destination policy |
| Page contract | Wrapper, record discriminators, required fields, nullability, cursor progression, and raw-to-normalized continuation translation |
| Failure contract | Sanitized status classes, retry classes, and action-required outcomes |
| Parallelism contract | Provider maximum of two per platform, PackScout operating at one request per platform, with independent-filter proof |
| Capacity contract | Page measurements plus full-history storage and bounded-memory forecast under the fixed retention policy |

## Acceptance Criteria

- [x] Sanitized initial, continuation, restart, and filter-isolation evidence exists for all four launch platforms without a reusable cursor or protected value.
- [x] A bounded profile-only connection probe succeeds without fabricated provider, filter, cursor, source, run, or page state, or task 002 is blocked for design review.
- [x] The exact page and record shapes, including `payment_method` and `available`, are represented without fabricated defaults.
- [x] At least two provider-filtered requests safely overlap, or the task reports a blocking design contradiction before implementation begins.
- [x] Request, response, retry, storage, memory, and retention bounds are concrete enough for tasks 002, 003, and 006 to test.

### Evidence safety proof

- [x] Security review finds no credential, personal identifier, transaction identity, proprietary payload, or unsafe upstream diagnostic in committed evidence.

### Adapter-readiness proof

- [x] Evidence supports one `dataforrest-events-v1` adapter shared by four source instances rather than four vendor clients.
- [x] Stable per-provider identity namespaces and relationship semantics are proven without committing actual provider record IDs.
- [x] Every normalized record shape has one evidence-backed record-ID scope, and legitimate cross-scope reuse is distinct from a kind or discriminator change inside one scope.
- [x] Launch record-ID scopes map injectively to canonical kinds, or the task stops before task 002 and reports the required canonical-identity redesign.
- [x] Every vendor field required by the normalized observation and continuation contract has one deterministic translation or a blocking contradiction.

## Verification

```bash
node --test scripts/local/capture-dataforest-evidence.test.mjs
npm run check:scripts
npm run check:docs
npm run test:tooling
git diff --check
```

The authenticated capture is a reviewed local-only evidence command, not a CI
dependency:

```bash
PACKSCOUT_DATA_API_TOKEN='<ignored local secret>' \
  npm run capture:dataforest-evidence:local -- --limit 250
```

## Spec Compliance

- Implemented the fixed-endpoint, environment-only capture harness, offline
  safety tests, reviewed evidence report, synthetic structural fixture, launch
  scorecard update, storage forecast, and task-006 memory benchmark contract.
- Later bounded evidence superseded the provisional transport settings: the
  launch target is 500 under an 8 MiB bound. Every retry keeps the exact durable
  request pin; the runtime never silently downshifts an oversized page.
- Rate-limit headers/thresholds remain explicitly unavailable; no harmful load
  or manufactured failure was used. Their safe
  retry classifications are documented without inventing an envelope.
- The reviewed local volume has insufficient capacity for the eventual real
  backfill. That is recorded as a task-010 preflight block, not hidden or treated
  as a transport-contract failure.
