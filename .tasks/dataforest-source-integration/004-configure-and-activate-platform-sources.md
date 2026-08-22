# Task: Configure and Activate Platform Sources

**ID:** dataforest-source-integration/004
**Depends on:** dataforest-source-integration/003
**Blocks:** dataforest-source-integration/007
**Estimated scope:** medium
**Estimated effort:** 2–3 days for one builder, including secret lifecycle, source activation, timing changes, and direct security tests
**Status:** done

## Start Here

Create one inactive shared DataForrest connection profile and one inactive Courtyard source, request their bounded test jobs, and prove activation remains blocked until current successful results are recorded.

## Objective

Let administrators configure, test, activate, pause, rotate, disable, and replace provider sources without exposing secrets, reusing an incompatible cursor, or changing another provider.

## Context

The bearer credential is shared, but cursor and scheduling state are not. An administrator enters the bearer once through PackScout's existing encrypted credential workflow. The worker receives only the credential-decryption keyring and reads the active encrypted revision; it does not require the plaintext DataForrest bearer as its own environment variable.

Activation starts a tested source in paused state. An explicit resume begins or continues ingestion from its durable cursor. This single paused state replaces the former ready-paused and operator-paused distinction while retaining role and audit boundaries.

First-pass admin creates only registered DataForrest connections and sources. The lifecycle commands are source-type-neutral, but this task does not add dynamic plugins, a universal configuration-form renderer, or a production alternate adapter.

## Requirements

### Shared connection lifecycle

- Let an administrator create one inactive DataForrest-compatible profile, store one encrypted credential revision scoped to organization, profile, and revision rather than provider, request a bounded connectivity test, and expose only source type, endpoint host, masked secret, and test state.
- Represent connection tests as bounded operational jobs that use task 003's source adapter and stable-profile request limit; this task owns validated requests, pending state, immutable results, and activation policy, while task 007 owns live execution.
- Let a tested same-endpoint credential rotation apply only to runs created after rotation; existing queued, running, and historical runs retain their pinned revision and source cursor.
- Let emergency revocation fence work pinned to the revoked revision before another fetch or commit while preserving the last committed source cursor.
- Treat an endpoint or source type change as a new profile and source replacement; an opaque cursor cannot move to a different profile or adapter.

### Source lifecycle

- Let an administrator create one source instance for a stable provider, registered `sourceTypeKey`, source revision, compatible profile, adapter-validated immutable configuration, and separately approved mapper key and version.
- Require current connection and source-test results that prove provider support, normalized-contract compatibility, replacement identity namespace, and record-ID scopes, then separately validate compatibility with task 002's exact mapper descriptor in generic activation orchestration; mapper metadata never enters the source adapter.
- Activate a source as paused, then resume a new source from a null cursor or an existing source from its preserved committed cursor.
- Permit one active source per provider and reject replacement until the old source is paused or disabled with no unfenced active run.
- Treat adapter, profile, endpoint, platform-filter, normalized-contract, record-ID-scope, mapper-version, or identity-namespace change as a new source instance with a null cursor; reject an incompatible scope or namespace and retain the old source history.

### Connection recovery

- Let one successful recovery test close a blocking episode on the same connection revision and resume eligible source work from committed cursors without changing run pins.
- When recovery activates a tested credential or connection revision, fence or finish work pinned to the blocked revision and create exactly one new-revision run per eligible source from its committed cursor; historical run provenance remains immutable.
- Persist each nonblocking normal or recovery test result through task 002's compare-and-transition guard: reference the terminal request attempt, require its request-time supervisor epoch to remain `active`, validate job lease, expected pre-test health generation, and applicable source revision, then atomically store the validated result, episode transition, and resulting generation; a request-boundary blocking failure already stored its result and is not terminalized twice.

### Timing and processor controls

- Default each source interval to 60 seconds, validate independent revisions from 60 through 86,400 seconds, and derive freshness from next due time plus a fixed 15-minute grace.
- Preserve cursor and current work when timing changes; the new interval controls the next schedule calculation after current work reaches a safe boundary.
- Pause after the current page commit, prevent another page or queued run, and preserve cursor and nonfailure health for resume.
- Disable future work and require an explicit tested activation or replacement flow before the source can run again.
- Make Run now, retry, processor pause, and resume available to administrators and data operators through task 007 behavior without granting source-configuration authority.

### Reset and permissions

- Restrict profile, secret, binding, filter, interval, activation, disable, replacement, and cursor reset to administrators.
- Require a provider-specific impact preview and confirmation before reset; the source must be paused or disabled and free of active leases.
- Increment cursor generation during reset so every fetch or commit from the older generation is rejected.
- Return stable validation, forbidden, conflict, dependency, test, and upstream failure results with a safe audit receipt.
- Cover authentication, authorization, tenant isolation, secret handling, external reads, rotation, activation conflict, and destructive reset with direct boundary tests.

## User-Facing Behavior

An administrator sees one shared DataForrest connection and four separately configured provider sources, including each source type and mapper version. A secret appears only as masked presence and revision state. A requested test remains Pending until the supervisor executes it. Source activation explains that ingestion starts paused; Resume begins from Feed start for a new source or from the displayed safe cursor fingerprint for the same existing source.

## Interface Contract

This task provides tenant-scoped commands and masked results for:

| Area | Commands and outcomes |
|---|---|
| Connection | Create, revise credential, test, normal rotate, emergency revoke |
| Source | Create with registered source type and mapper pin, test configuration, activate paused, resume, pause, disable, replace |
| Timing | Read and revise the independent 60–86,400-second interval |
| Cursor | Preview and reset with generation fencing |
| Audit | Safe actor, source, revision, action, result, and timestamp receipt |

## Acceptance Criteria

- [x] One encrypted credential can bind four source instances without entering worker configuration, browser responses, diagnostics, or audit bodies in plaintext.
- [x] Missing, pending, failed, or outdated test results cannot activate a source, while recording a current successful result cannot move a cursor or create provider data; task 007 owns live test execution proof.
- [x] Normal credential rotation preserves pinned work and cursors; emergency revocation fences only affected work.
- [x] Source type, filter, endpoint, normalized-contract, record-ID-scope, mapper, or identity-namespace changes require a new source and cannot reuse a cursor, while timing-only changes preserve it.
- [x] Activation, pause, resume, disable, replacement, and reset affect only the selected provider and produce complete safe audit evidence.

### Abstraction proof

- [x] Activation validates task 002's contract-only mapper descriptor and rejects unregistered source types, incompatible profile types, unsupported providers, normalized-contract mismatch, record-ID-scope mismatch, mapper mismatch, and identity-namespace mismatch without depending on task 005's implementation.
- [x] A tested compatible replacement starts paused at a null cursor, preserves the prior source and provenance, and cannot transfer or convert the old cursor.
- [x] Production admin can select only `dataforrest-events-v1`; the test-only adapter and dynamic adapter configuration are unavailable.

### Security proof

- [x] Direct tests enforce administrator-only configuration and reset, authorized operator controls, tenant isolation, confirmation, redaction, and stable errors.

## Verification

- PASS: focused source-connection cipher, connection lifecycle, source lifecycle, activation, masked-catalog, and recovery service suites (20 tests in the orchestrator rerun; 23 in the final implementation batch).
- PASS: focused provider-source admin contract suite (4 tests).
- PASS: focused admin route/runtime behavior (9 tests) and source-configuration UI cases (6 tests through the repository admin test harness).
- PASS: provider-source activation, admin lifecycle, recovery, rotation, replacement, reset, tenant-isolation, and exact-fence database regressions (42 Task004-relevant cases in the orchestrator database pass).
- PASS: independent post-fix acceptance audit, including the repaired exact same-revision recovery fixture; no remaining P1/P2 finding.
- PASS: contracts, database, services, and admin focused typecheck/lint; `npm run scan:framework-standards:ratchet` reported 0 findings in the final implementation batch.
- NOTE: the repository-wide admin lane currently reaches 80/81; its unrelated entrypoint readiness case is expected to remain red while Task007's newer in-progress migration has not yet refreshed the shared final readiness metadata. Task004-specific behavior is green, and the full lane remains a mandatory integration gate after Task007 settles.

## Spec Compliance

- Related specs reviewed: none.
- Alignment: implemented one encrypted shared connection lifecycle, adapter-owned source configuration, contract-only mapper activation, latest exact test guards, paused activation/reactivation, cursor-preserving timing and rotation, explicit emergency recovery, safe reset, tenant-scoped audit evidence, and a production-only DataForrest admin surface.
- Divergences: none. Live execution of queued connection/source tests, processor Run/Retry behavior, and safe page-boundary pause remain with Task007 as assigned; no alternate production adapter or compatibility path was introduced.
- Verification: the commands and independent audit above; every Task004 acceptance criterion is directly covered.
