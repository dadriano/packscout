# Task: Read DataForrest Pages Through the Source Adapter

**ID:** dataforest-source-integration/003
**Depends on:** dataforest-source-integration/002
**Blocks:** dataforest-source-integration/004, dataforest-source-integration/006
**Estimated scope:** medium
**Estimated effort:** 3–4 days for one builder, including adapter conformance, shared-client reuse, strict validation, bounded failures, and focused tests
**Status:** not started

## Start Here

Read one sanitized Courtyard fixture through `dataforrest-events-v1` and one differently wrapped fixture through a test-only adapter, then prove both return the same normalized observation-page contract without exposing either vendor's pagination fields.

## Objective

Implement DataForrest as one registered provider-source adapter that all four source instances can use while generic orchestration, mapping, importing, and admin behavior remain independent of DataForrest.

## Context

Each DataForrest source instance supplies an immutable platform filter and its own nullable opaque checkpoint. All four use the same connection profile, request policy, authentication behavior, and response validation. Only the DataForrest adapter understands `/v1/events`, bearer authentication, the vendor wrapper, cursor encoding, or `poll_after_seconds`.

The adapter decodes and validates transport data into task 002's normalized observation page. It does not select a platform mapper, create canonical candidates, commit checkpoints, schedule runs, or publish public records.

First-pass request limiting is process-local because exactly one supervisor process is supported. Task 002 defines a generic stable-profile coordinator and task 007 owns its runtime sequencing. The DataForrest adapter receives a fenced request lease from that coordinator and cannot acquire capacity or call upstream without it.

## Requirements

### Adapter boundary

- Register one compile-time production source type, `dataforrest-events-v1`, compatible with the shared DataForrest connection type and the four approved providers; do not create one adapter per platform.
- Validate adapter-specific connection and source configuration, test a connection, test one filtered source, and read or cancel one bounded page through task 002's source-adapter contract.
- Return protected raw-page evidence, ordered normalized valid and invalid observations, opaque next checkpoint, normalized continuation, safe measurements, diagnostic drafts, or one stable failure.
- Keep platform canonical mapping, persistence, scheduling, and public behavior outside the adapter.

### Operation-specific inputs

- Build every call from task 002's correlation-free connection or source operation base; mapper keys, mapper descriptors, and canonical behavior never enter the adapter input.
- Add only connection-test correlation for a connection test and only source-test correlation for a source test; neither carries checkpoint, run, or page state.
- Add only requested checkpoint envelope, checkpoint generation, run and page correlation, and page limit for a page read; it does not inherit either test correlation.

### DataForrest request behavior

- Execute task 001's exact bounded profile-only connection probe under one generic execution slot retained through its terminal or fenced test result, using connection configuration and no provider, platform filter, cursor, source, run, or page state; if DataForrest cannot support that shape, task 001 blocks this adapter rather than fabricating source context.
- Execute a source test with its immutable platform filter, null ephemeral cursor, bounded test limit, and one generic execution slot retained through its complete attempt; capture and terminalize the request attempt, release the profile permit, then validate and discard its protected page and returned cursor under that slot and test job without advancing durable source state.
- Execute a page read with its immutable platform filter, bounded page limit, and requested opaque cursor, omitting cursor only at that source generation's start.
- Pass a page read's returned cursor back byte-for-byte with the same source filter without parsing, synthesizing, truncating, or logging it outside the adapter.

### Shared request safeguards

- Apply the task-001 timeout, response-size, redirect, destination, TLS, and page-limit bounds before exposing protected data.
- Bind every invocation to immutable connection-profile context, bind source tests and page reads to immutable source-revision context, and return only the operation's safe correlation data for diagnostics.

### Connection-profile request control

- Require a current task-002 request lease matching the operation kind, correlation, singleton epoch, job or run lease, connection revision, revocation and connection-health generation, applicable source revision and lifecycle, applicable checkpoint generation, connection profile, and abort signal before a DataForrest client call; while a blocking episode is open, accept only the single recovery connection-test lease explicitly correlated to that episode and reject normal connection tests, source tests, and page reads.
- Make exactly one bounded DataForrest request under that lease and prohibit nested, reused, wrong-profile, wrong-epoch, or unmetered subrequests.
- At the hardened request boundary, return a normalized request outcome before lease close and require the generic coordinator to terminalize its durable request attempt before permit wake for every outcome. A typed connection-blocking outcome combines terminalization with detecting-lease CAS and durable episode create or coalesce; a blocking test failure also persists its immutable result there. Exhausted persistence leaves the attempt nonterminal and starts full owner drain. Page normalization, source-test validation, mapping, and persistence never hold the permit and cannot begin from a nonterminal attempt.
- Return bounded request measurements without exposing other tenants, sources, credentials, checkpoint values, or request details.
- Prove focused adapter calls fail closed with zero upstream requests when the lease is absent, stale, cancelled, or mismatched.

### DataForrest response validation

- Validate the connection probe's task-001-approved masked connectivity/auth result without producing normalized observations, a checkpoint, or source diagnostics.

### Filtered source response validation

- Validate `records`, `next_cursor`, and `poll_after_seconds` for source tests and page reads before any record reaches a mapper or test result.
- Accept catalog, pulls, and trades together for source tests and page reads only when every record is evaluated against that operation's configured platform filter.
- Return indexed invalid-record results for missing identity, unknown stream, platform mismatch, invalid timestamp, and missing required stream fields so valid siblings may continue later.
- Preserve exact replay and a structurally valid empty page as valid input under the evidence-backed cursor rules.
- Treat malformed wrapper, unsafe collection size, invalid next cursor, and invalid continuation as fatal page failures.

### Continuation translation

- Translate a source test or page read's `poll_after_seconds = 0` to `continue` and `60` to `poll_after` with a 60-second minimum; reject any unsupported value inside the adapter, then discard source-test continuation after validation.
- For a page-read `continue`, require a nonnull next checkpoint different from the requested checkpoint; task 006 owns cross-page cycle detection, while `poll_after` may preserve the prior checkpoint, including null for a future stateless adapter.

### Failure classification

- Classify credential, authorization, endpoint, TLS, redirect-destination, and connection-profile configuration failures as one connection-revision action-required episode with no source checkpoint change.
- Classify platform filter, source configuration, cursor, normalized-contract, identity-namespace, record-ID-scope, and source-owned limit failures as source action required and never restart automatically from null.
- Classify timeout, transient network, supported server failures, and observed rate limiting as retryable against the same checkpoint and revision context, retaining operation scope unless connection-health policy opens one shared profile episode.
- Bound retries, upstream status, response excerpts, and exception details before producing an operator-safe diagnostic draft.
- Never return a credential, authorization header, full endpoint query, full cursor, raw body, provider payload, personal identifier, or stack trace.

### Registration boundary

- Keep Courtyard, Collector Crypt, Phygitals, and ClutchPacks mapping outside the DataForrest adapter and resolve it later from the separately pinned mapper key and version.
- Reject old aggregate pages, `has_more`, stream-selector requests, and independent catalog, pull, or trade cursors.
- Let task 006 own the final production composition change that removes obsolete DataForrest runtime paths.

### Test-only conformance boundary

- Register one alternate source adapter only in tests with a different raw wrapper, checkpoint grammar, and continuation signal but the same normalized Courtyard record contract and identity namespace.
- Keep the test adapter out of the exported production source-type manifest and prohibit dynamic adapter loading or unregistered source types; tasks 004 and 008 own admin invisibility.
- Enforce a focused boundary check that the provider-source contract and adapter conformance harness do not expose DataForrest transport types or fields; tasks 005 through 008 own mapper, importer, scheduler, persistence, and admin enforcement, and task 010 owns the repository-wide check.

## User-Facing Behavior

None directly. Admin receives only masked test results and sanitized diagnostics through tasks 004 and 008.

## Interface Contract

The adapter accepts a mutually exclusive discriminated union built from two correlation-free bases. `ConnectionOperationBase` contains adapter and connection context; `SourceOperationBase` adds provider, source revision, immutable source configuration, normalized contract, replacement identity namespace, and record-ID scopes but no mapper metadata.

| Operation | Required input |
|---|---|
| Connection test | `ConnectionOperationBase` plus connection-test correlation only |
| Source test | `SourceOperationBase` plus source-test correlation only; no connection-test, checkpoint, run, or page correlation |
| Page read | `SourceOperationBase` plus requested checkpoint envelope, generation, run, page, and page limit only; no test correlation |

Output is either:

- a masked connection or source-test result with measurements and no checkpoint effect;
- a normalized page containing protected raw evidence, ordered valid and invalid observation results, opaque next checkpoint, `continue` or `poll_after(minimumDelaySeconds)`, response measurements, and safe diagnostic drafts; or
- a stable retryable or action-required failure with no checkpoint advancement and no protected values.

## Acceptance Criteria

- [ ] `dataforrest-events-v1` passes initial, continuation, restart, empty, replay, mixed-stream, and poll-after fixtures for all four filters.
- [ ] Fatal page defects and record-local invalid results remain distinct and deterministic.
- [ ] Two or more source reads overlap up to the approved cap without sharing filters, checkpoints, revisions, results, or diagnostics.
- [ ] Connection tests, source tests, and imports require the same request-lease contract and make zero calls for absent, stale, cancelled, reused, or mismatched leases.
- [ ] Concurrent typed connection failures use detecting-request-lease CAS so one advances health, siblings coalesce, stale detectors cannot mutate it, and no profile permit wakes bound work before the durable result; exhausted persistence under the shared retry policy fences and drains the whole supervisor.

### Operation-shape proof

- [ ] Connection-probe, filtered source-test, and filtered page-read fixtures prove mutually exclusive request and response rules without fabricated source state or durable test checkpoints.
- [ ] Redaction tests prove secrets, full cursors, protected records, upstream bodies, and stack details cannot cross the source boundary.

### Abstraction proof

- [ ] DataForrest wrapper, cursor, and poll fields are absent from the provider-source contract, normalized page, and adapter conformance harness; task 010 owns the repository-wide dependency check after downstream migrations complete.
- [ ] The test-only alternate adapter satisfies the same connection-test, source-test, page, checkpoint, continuation, failure, and diagnostic contract.
- [ ] The adapter contract returns the alternate checkpoint without parsing it and validates its output against the fixed normalized Courtyard observation contract; task 006 owns mapper and importer integration.
- [ ] DataForrest calls consume exactly one granted request lease and cannot create nested or unmetered upstream requests; task 007 owns live FIFO and cap proof.
- [ ] The production source-type manifest contains only `dataforrest-events-v1`; the alternate adapter exists only in the focused conformance harness, and tasks 004 and 008 own admin exclusion.

### Operation-scope proof

- [ ] Compile-time and runtime conformance rejects connection tests with source fields, source tests with connection-test or page fields, page reads with test fields, and every adapter input containing mapper metadata.
- [ ] A permit granted after its queued operation becomes stale, revoked, disabled, replaced, or generation-mismatched produces zero DataForrest requests.

### Legacy rejection proof

- [ ] Aggregate wrappers, `has_more`, stream-selector requests, and per-stream cursor fixtures are rejected and cannot be registered as the DataForrest source.
