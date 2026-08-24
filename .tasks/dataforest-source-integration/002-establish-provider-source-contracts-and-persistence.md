# Task: Establish Provider-Source Contracts and Persistence

**ID:** dataforest-source-integration/002
**Depends on:** dataforest-source-integration/001
**Blocks:** dataforest-source-integration/003, dataforest-source-integration/005
**Estimated scope:** large
**Estimated effort:** 3–4 days for one builder, including source-adapter contracts, migrations, lifecycle contracts, retention boundaries, and focused verification
**Status:** done

## Start Here

Define one normalized observation-page contract from a sanitized DataForrest fixture and a deliberately different alternate-source fixture, then prove the contract represents both page and cursor shapes without importing either vendor wrapper.

## Objective

Give every later task one durable, vendor-neutral abstraction for stable providers, registered source adapters, replaceable source instances, shared connections, independent processor state, canonical record identity, and bounded diagnostics.

## Context

A PackScout provider is the stable platform identity. A source instance is the replaceable way PackScout obtains that provider's data. A registered source adapter is the only layer that understands a vendor API, SDK, authentication shape, pagination, or polling vocabulary. Courtyard, Collector Crypt, Phygitals, and ClutchPacks each receive a DataForrest-backed source instance that uses one shared connection profile and source-adapter implementation.

The existing pipeline already separates transport and platform mapping adapters, but its transport contract returns an obsolete vendor-shaped feed page. This task replaces that leaky boundary with one normalized provider-source contract and adapts existing schedules, queued runs, leases, cursors, health, quarantine, atomic page evidence, and canonical history to source-instance ownership.

## Requirements

### Versioned launch contract

- Publish one versioned provider-source contract as the sole authority for adapter capabilities, normalized observations, cursor envelopes, continuation, identity, failure, lifecycle, schedule bounds, freshness grace, retention, singleton lease timing, and control-plane retry policy.
- Publish a separate versioned DataForrest adapter contract as the authority for its filters, raw wrapper, event codes, pagination hints, request bounds, and connection-scoped concurrency.
- Bind both applicable contract revisions to connection profiles, source revisions, runs, diagnostics, and local completion evidence wherever those values affect interpretation.
- Require worker, server, admin, migration, and test consumers to read the shared values instead of carrying independent defaults.
- Expose only safe effective settings and revision identity to operators; the contract never contains a credential or protected payload.

### Source adapter contract

- Give every compile-time registered source type a stable `sourceTypeKey` and adapter version, normalized-record contract version, compatible connection type, supported providers, per-provider replacement identity-namespace key, evidence-backed record-ID scope declarations, capabilities, validated configuration contracts, and safe operator label; never reuse this identity as a mapper key.
- Require the adapter boundary to test a connection, test a source, execute or cancel one bounded request under a runtime-granted connection permit, classify failures, and report measurements without moving a cursor itself.
- Normalize every successful page to one provider key, ordered observation outcomes, an adapter-owned cursor envelope, and exactly `{ kind: continue }` or `{ kind: poll_after, minimumDelaySeconds }`, where the delay is a required integer from 0 through 86,400.
- Normalize each valid observation to `providerRecordIdentity = { recordIdScopeKey, providerRecordId }`, catalog/pull/trade kind, effective and collection times, scope-qualified relationship identities, approved event, money, payment, and availability facts, strict source-neutral display/value/EV provider facts, plus a protected native-evidence reference.
- Keep mapping-relevant provider facts in one closed, versioned semantic schema and include them in the semantic observation hash. Protected native evidence remains provenance/quarantine input only and can neither reach a mapper nor override normalized facts; authoritative sold out remains distinct from ordinary unavailable.
- Keep raw wrapper fields, SDK objects, endpoint details, credentials, vendor cursors, and vendor polling values inside the registered adapter.

### Adapter operation scopes

- Define a correlation-free `ConnectionOperationBase` containing source type and adapter version, connection profile and revision, request lease, bounds, and abort signal.
- Define a correlation-free `SourceOperationBase` containing the connection base plus provider, source and revision, normalized-contract version, replacement identity namespace, record-ID scope declarations, and immutable source configuration; mapper metadata is absent.
- Use a discriminated union: connection test adds only connection-test correlation, source test adds only source-test correlation to the source base, and page read adds only cursor, generation, run, page, and page-limit correlation to the source base.
- Require every result and diagnostic to retain exactly its operation scope without inheriting or fabricating test, provider, source, cursor, run, or page identifiers.

### Durable test-result guard

- Bind every connection- or source-test attempt to its job claim lease, request-time singleton fencing epoch, connection revision and expected pre-test health generation, and for a source test its source revision.
- Hold one generic execution slot for each complete connection- or source-test attempt. After the request boundary terminalizes capture and releases its profile permit, retain that slot through bounded validation and one compare-and-transition transaction that references the terminal attempt and test pins, persists the immutable validated result, retains or closes the applicable blocking episode, and stores both pre-test and resulting health generations; release the slot only when the result is terminal or fenced, and let only an unrelated concurrent generation change fence it.
- For a request-boundary blocking test failure only, combine request-attempt terminalization, immutable failed result, and episode transition before the permit wakes another waiter; do not terminalize the same attempt again later.

### Mapper compatibility descriptors

- Publish one contract-only launch descriptor for each of Courtyard, Collector Crypt, Phygitals, and ClutchPacks containing stable mapper key and version, provider, normalized-record contract version, and identity-namespace key.
- Make source revisions pin exactly one descriptor independently of `sourceTypeKey`; adapter manifests and mapper descriptors cannot reuse or overwrite each other's identities.
- Let activation validate descriptor compatibility from this manifest before mapper implementations exist; unregistered, provider-mismatched, contract-mismatched, or namespace-mismatched descriptors fail closed.
- Require task 005 mapper implementations to satisfy these exact descriptors and task 006 production composition to prove every pin resolves once.

### Connection permit contract

- Give the generic runtime one process-local, tenant-safe permit coordinator keyed by stable connection-profile identity and configured from that profile's approved aggregate cap.
- Make every connection test, source test, and page read wait cancelably in one FIFO profile queue; a pending operation holds neither an execution slot nor a request permit until the generic runtime can admit it with both resources, and adapter code cannot acquire a separate permit pool.
- After paired grant and immediately before invocation, require one authoritative operation-specific guard to validate that the singleton epoch is active, the job or run claim lease, profile and pinned connection revision plus revocation and connection-health generation, applicable source revision and lifecycle, and for page reads the requested cursor and generation; failed validation atomically releases both reserved resources without creating a request attempt or calling the adapter.
- Issue one nontransferable request lease bound to every applicable validated pin and permit exactly one bounded upstream request. Reject nested, reused, stale-job, stale-run, disabled-source, revoked-profile, stale-health-generation, wrong-cursor, wrong-generation, wrong-profile, wrong-epoch, or unmetered requests, and reject every operation under a blocking connection episode except the one current pending or running recovery connection-test job explicitly bound to that episode, its open health generation, and one nonrevoked same or candidate target revision.
- Persist the durable `in_flight` request attempt after paired admission and guard validation but before invoking the adapter. If that pre-call insert cannot commit under the exact shared control-plane retry policy, close the unused one-use lease, release both reserved resources, make zero upstream calls, and enter the same full-supervisor self-fencing path; no synthetic attempt row or success diagnostic is invented.
- Before auto-closing the request lease or waking the profile permit, terminalize the durable request attempt for every bounded response capture or normalized request failure. For a typed connection-blocking failure, combine terminalization with compare-and-transition on the detecting lease's active singleton epoch, job or run claim, connection revision, and expected health generation; one current detector opens the episode, simultaneous detectors coalesce, and stale detectors cannot mutate health. Include the immutable failed result only when this is a blocking test attempt. Apply the exact shared control-plane retry policy; exhaustion starts full supervisor fencing and leaves the attempt nonterminal. Page normalization or source-test validation begins only after successful boundary terminalization.

### Control-plane retry and owner fencing

- Freeze one shared retry policy in the versioned contract: at most three transaction attempts, the first immediately and then after 100 ms and 400 ms, each with a 750 ms database timeout and a hard three-second wall-clock limit.
- Retry only transient connection, timeout, serialization, or deadlock failures; an invariant, stale-fence, cancellation, or lost-ownership result does not retry, and every retry revalidates the same request attempt and active owner epoch.
- On exhaustion, irreversibly self-fence the runtime in memory before attempting the durable compare-and-transition from `active` to `fenced_draining`; after the local fence, issue no new adapter call or persistence transaction. A successful durable transition is the hard database fence: page commits and test-result transactions lock and require the same `active` epoch, so they either commit before that transition or fail after it. If the state write is unavailable, stop renewal, abort outstanding work, keep retrying only the fence transition, and exit without resuming persistence; an already-submitted transaction may have committed only under the still-active predecessor epoch before the fence became durable, and takeover must reconcile that durable outcome after expiry plus grace rather than claim an impossible zero-result guarantee.

### Uncertain request recovery

- Persist a sanitized request-attempt row with operation kind, profile/source correlation, validated fences, and `in_flight` state immediately before the upstream call; completing classification or capture makes it terminal without storing protected request or response values.
- Require terminalization for every outcome and the applicable blocking transition to commit before permit wake, page normalization, or test-result publication; bounded idempotent retry exhaustion leaves the attempt nonterminal.
- On exhaustion, drain the whole supervisor: stop all claims, abort active request leases across profiles, allow no captured page or test result to persist, and release the fenced epoch only after zero active requests or otherwise let the lease expire plus takeover grace.
- Before a replacement owner issues any adapter call, reconcile every nonterminal attempt whose predecessor epoch is safely released or superseded, or expired through takeover grace; atomically terminalize it as `connection_outcome_uncertain`, create or coalesce one blocking episode for its profile revision, and then continue independent profiles normally.
- Expose the uncertain episode and recovery-test path through the same durable health, diagnostic, and admin contracts; a successful correlated recovery test is required before bound source work resumes.

### Connection-failure fencing

- Give every connection revision a monotonic health generation and optional blocking action-required episode; normal connection tests, source tests, and page reads bind the current open generation.
- Opening a blocking credential, authorization, endpoint, TLS, destination, or profile-configuration episode advances the generation once, cancels queued source tests and page reads, aborts uncompleted request leases, and fences later page commits; simultaneous request-detected failures coalesce by request-lease-fenced compare-and-transition before either permit wakes another waiter.
- Permit at most one pending or running recovery connection test per blocking episode, coalesce duplicate requests, and record every attempt immutably; failure leaves the episode open and permits a later explicitly correlated attempt, including one for a new candidate revision, while no attempt may carry source state or advance a cursor.
- A successful same-revision recovery records its immutable result and closes the episode under one compare-and-transition transaction with a new health generation so eligible work may resume from committed cursors; activating a tested replacement connection revision terminates or fences old-revision work and creates new-revision work from those cursors without mutating old run pins.

### Ownership model

- Keep stable organization-scoped provider identity separate from connection profiles, source types, and source instances.
- Make each connection profile belong to one registered source type and own adapter-validated encrypted configuration, tested state, and one stable-profile request limit shared by its credential revisions, source reads, connection tests, and source tests.
- Make each source instance own one provider, one registered `sourceTypeKey`, a compatible profile, adapter-validated immutable configuration, a separate mapper key and version, identity namespace, lifecycle state, schedule, cursor, runs, leases, health, and processor diagnostic feed.
- Enforce at most one active source instance per provider while retaining inactive historical source instances for audit and future source replacement.
- Scope opaque cursors and processor state to source instances while keeping canonical business identity independent of source-instance and connection-profile identities.

### Timing revisions

- Keep timing revisions in the source's separate schedule history; interval-only changes do not create a new source revision or rebind its cursor.

### Durable scheduling and runs

- Re-key the existing durable schedule, queued-run, lease, cursor, page, and health behavior to source instances rather than adding a work-intent table.
- Store only due work as queued import runs; future schedule timing remains in the durable source schedule until it becomes due.
- Permit at most one queued or running import per source, with scheduled, manual, continuation, and recovery triggers represented on the run.
- Pin a queued or running import to provider, source instance and revision, `sourceTypeKey` and adapter contract, normalized-record contract, `mapperKey` and mapper version, identity namespace, connection-profile revision, cursor codec and generation, and requested opaque cursor; normal revision rotation cannot rewrite it.
- Fence stale leases, disabled or replaced sources, emergency-revoked credentials, and old cursor generations before another fetch or commit.

### Opaque cursor guard

- Bind each cursor envelope to source instance, source revision, source-adapter contract, cursor codec, and cursor generation; generic code may bound, compare, store, and fingerprint its exact text value but never parse or convert it.
- Let an adapter validate its own cursor grammar and reject an immediate `continue` result whose next cursor is null or equals the requested cursor.
- Before commit, reject a `continue` result whose safe next-cursor fingerprint already exists in that source and generation, including an A-to-B-to-A cycle across runs or restarts.
- Allow `poll_after` to preserve the requested cursor, including null, because it does not request an immediate next page.
- Reset cycle history only through a confirmed cursor-generation reset or a distinct replacement source, never through retry, restart, timing change, or credential rotation.

### Stable source-record identity

- Key a stable source record by organization, source instance, contract-defined `recordIdScopeKey`, and provider record ID so two source instances or legitimately distinct ID scopes cannot deduplicate each other accidentally.
- Treat record kind and pack/card discriminator as immutable meaning inside one record-ID scope; changing either is an identity conflict, while the same raw ID in two separately evidenced scopes is not.
- Require replacement adapters to emit the same record-ID scopes and provider IDs under the approved provider identity namespace; generic code never invents a scope from a vendor wrapper.

### Observation and occurrence identity

- Key one semantic source observation by stable source record, effective source time, normalized-contract and hash version, and normalized-content hash; collection-only time and delivery lineage are excluded from the hash.
- Key one delivery occurrence by page and record index, referencing its semantic observation when valid and retaining adapter, connection, mapper, collection time, evidence reference, and disposition lineage.
- On exact replay in a different page or credential revision, add the new occurrence but not a second semantic observation, canonical revision, or EV request.
- On changed effective time or normalized content, add one semantic observation and occurrence, then let task 005 decide catalog revision versus identity or immutable-event conflict.

### Replacement identity and provenance

- Keep canonical business identity scoped to organization, stable provider, canonical kind, and provider record ID so a compatible replacement source does not create a second business object; identity namespace is a source-compatibility assertion, not part of the canonical key.
- Require every activatable source type to declare the same provider-specific identity-namespace key as the pinned mapper descriptor and prove that its emitted provider record IDs belong to that namespace.
- Start every replacement source with its own null cursor and retain the old source, cursor, adapter revision, and observation provenance for audit.
- Reject a replacement whose record IDs differ; identity bridging, automatic cursor transfer, and cross-source reconciliation require a separate approved feature.

### Canonical identity domains

- Freeze an injective launch mapping from each provider's catalog-pack, catalog-card, pull, and trade record-ID scope to pack, catalog asset, pull, and market-event canonical identity domains; two distinct scopes cannot map to the same canonical kind.
- Keep the canonical key organization, stable provider, canonical kind, and provider record ID because the canonical kind uniquely carries the launch record-ID scope; validate the scope-to-kind mapping before projection.
- Require every normalized relationship target to carry its record-ID scope and resolve only through that scope's canonical kind, so equal raw IDs cannot bind the wrong pack, card, pull, or event.
- Reject a future adapter or contract that introduces two scopes for one canonical kind; supporting that shape requires a separately reviewed canonical-identity migration.

### Record and enum migration

- Define internal source kinds as catalog, pull, and trade; preserve the exact upstream stream value in protected provenance.
- Map catalog pack to canonical pack, catalog card to the existing generic catalog asset with card type, pull to canonical pull, and trade to canonical market event.
- Preserve the existing derived platform, EV input, and estimated-EV kinds and their relationships.
- Replace obsolete source or canonical sale-kind counters, filters, and relationships with trade or market-event meaning; keep `sale` only as an event-type value.
- Use a clean forward migration for this unlaunched provider state without aliases, dual reads, dual writes, or a compatibility enum.

### Evidence and retention

- Store one authoritative protected raw page payload for seven days and compact semantic observations plus delivery occurrences that refer to that page instead of duplicating every accepted raw payload.
- Retain a protected copy of quarantined record evidence for 30 days, independent of the page payload's expiry, so retry remains possible.
- Preserve hashes, dispositions, canonical history, relationships, EV work, cursors, run summaries, health, and operator audits after protected payload expiry.
- Persist sanitized diagnostic events for 30 days under an exact scope discriminator of `source` or `connection` with common severity, phase, code, timing, counters, and immutable event identity.
- Make all retention work tenant-scoped, bounded, restart-safe, and auditable; expiry cannot remove current cursor state or unresolved quarantine evidence before its own deadline.

### Request-attempt retention

- Retain terminal request-attempt rows for 30 days, then compact them in bounded tenant-scoped batches while preserving immutable attempt identity, outcome class, safe hash, and request-time fence correlation on page, test, run, or audit lineage.
- Never expire a nonterminal attempt; uncertain reconciliation must first terminalize it and link its blocking episode, after which the normal 30-day terminal-row retention and compaction policy applies.
- Make compaction restart-safe and prove it cannot remove the terminal proof required by an uncommitted page or test transaction.

### Diagnostic event scope

- Give every event an immutable identity, occurrence time, scope, event kind, severity, phase, safe code, and bounded evidence; correlation fields are required by event kind rather than fabricated universally.
- Require provider, source, source revision, and command or audit correlation for source lifecycle events; idle pause, resume, activation, and recovery events need no run or page.
- Require a test-job identity for connection or source-test events, a run identity and trigger for run events, and both run plus page or request correlation for page events.
- Require organization, connection profile revision, and failure or test episode for connection-scoped events, with provider and source absent from the stored event.
- Store a connection event once, order merged feeds by occurrence time plus event identity, and project it only for sources bound to that profile at event time without crossing tenant, profile, source, or binding-time boundaries.

### Diagnostic safety

- Prohibit credentials, authorization headers, raw bodies, full cursors or vendor cursors, wallets, usernames, transaction identities, provider payloads, and stack dumps from diagnostic events.
- Use safe cursor and request fingerprints rather than reusable values.
- Emit page and lifecycle diagnostics for accepted work rather than one event per accepted record.
- Keep record-local details in quarantine with bounded reason codes and sanitized summaries.
- Prevent cross-tenant or cross-source reads of runs, pages, health, source-scoped diagnostics, and retained evidence while allowing only the approved bound-profile connection events in a source feed.

## User-Facing Behavior

None directly. Tasks 004 and 008 expose the masked lifecycle, progress, and log-feed views built on these contracts.

## Interface Contract

### Source boundaries

| Boundary | Durable owner and meaning |
|---|---|
| Provider | Stable organization-scoped platform identity |
| Source-adapter manifest | Adapter and normalized-contract versions, compatible profile type, capabilities, providers, and identity namespaces |
| Connection profile | Adapter-compatible encrypted configuration, stable-profile request cap, revisions, tests, health generation, and optional blocking episode |
| Source instance | Provider binding, adapter and config revisions, immutable configuration, lifecycle, schedule, cursor envelope, health, and logs |

### Runtime boundaries

| Boundary | Durable owner and meaning |
|---|---|
| Normalized page | Ordered observation outcomes, opaque next cursor, normalized continuation, measurements, and safe diagnostics |
| Source observation | One semantic fact keyed by stable source record, effective source time, normalized-contract/hash version, and normalized-content hash |
| Observation occurrence | One page-and-record-index delivery referencing the semantic observation or invalid outcome and retaining complete delivery lineage and disposition |
| Import run | Due trigger, source type and revision, adapter and normalized-contract revisions, mapper key and version, namespace and connection pins, cursor generation, requested cursor, lease, progress, and terminal outcome |
| Page attempt | Run and request lease plus request-time supervisor fencing epoch and connection-health generation, requested cursor/generation, response capture, and atomic commit outcome |
| Request attempt | Sanitized pre-call operation and fence correlation with in-flight or terminal state; a nonterminal attempt from any noncurrent predecessor epoch must terminalize as uncertain and link a blocking episode before another call |
| Diagnostic event | Sanitized source or connection event with scope-valid correlation, total ordering, binding-time projection, and 30-day expiry |
| Canonical identity | Organization, stable provider, canonical kind, and provider record ID; the frozen injective scope-to-kind map makes the canonical kind carry record-ID scope, while replacement namespace gates compatibility |

## Acceptance Criteria

### Ownership proof

- [x] Four source instances share one encrypted connection profile while retaining different cursors, schedules, runs, health, and diagnostic events.
- [x] One provider cannot have overlapping active sources or imports, while different providers may own active runs concurrently.
- [x] Replacing one provider's active source preserves stable provider and canonical identity and does not mutate another provider.
- [x] Queued and running imports retain immutable source type, adapter, normalized-contract, mapper, namespace, connection, source, cursor, and generation pins; stale or revoked owners cannot fetch or commit.

### Adapter proof

- [x] DataForrest and alternate-source contract fixtures map to the same normalized record, cursor, continuation, failure, and diagnostic contract without vendor fields reaching generic consumers; task 003 owns the executable adapters.
- [x] Generic code may bound, compare, store, and fingerprint opaque cursor text but cannot parse, convert, or transfer it between sources or adapters.
- [x] All revisions, tests, and reads under one connection profile share one cancelable FIFO request cap, while a different profile has independent capacity.
- [x] Every run retains its adapter, normalized-contract, connection, source, identity-namespace, cursor-codec, and generation pins; every delivery occurrence traces those applicable pins, while a semantic observation retains only its stable source record and contract/hash identity.

### Identity compatibility proof

- [x] Evidence-backed record-ID scopes distinguish legitimate raw-ID reuse from a kind or discriminator change inside one scope, and replacement adapters cannot silently change those scopes.
- [x] Every launch scope maps to exactly one distinct canonical kind, every relationship target is scope-qualified, and a second scope for the same canonical kind fails closed.
- [x] Four exact mapper compatibility descriptors exist before activation, remain distinct from source-adapter identities, and task 005 implementations must match them.

### Continuation and fencing proof

- [x] `continue` carries no delay, while `poll_after` always carries a validated 0–86,400-second integer minimum; missing, extra, fractional, negative, or excessive values are rejected.
- [x] A contract harness proves permit grant followed by singleton-epoch validation before one adapter request, with cancellation or lost ownership producing no request; task 007 owns live supervisor and takeover proof.
- [x] Immediate and cross-page cursor repeats are rejected for `continue`, including A-to-B-to-A after restart, while a valid `poll_after` may preserve its cursor.

### Data proof

- [x] The explicit catalog, pull, trade, pack, catalog-asset, market-event, platform, EV-input, and estimated-EV mapping has migration and contract coverage.
- [x] Exact replay reuses one semantic observation while each separately delivered page can add its own occurrence; changed time or content creates one semantic observation plus occurrence with complete delivery lineage. Task 006 owns the final atomic canonical-revision and EV-request no-op proof.
- [x] One raw page copy expires after seven days, quarantine evidence expires after 30 days, and durable normalized history and audits remain intact.
- [x] Source diagnostics and stored-once connection events merge in deterministic order only for sources bound to that profile at event time, remain redacted for 30 days, and cannot cross tenants or profiles.
- [x] Aggregate pages, `has_more`, sale-as-record-kind, per-stream cursors, aliases, and dual writes are absent from the replacement contract.

## Verification

- PASS: `npm run check:prisma`
- PASS: `npm run test:contracts` (157 tests)
- PASS: `npm run test:services` (458 unit tests and 1 volume test)
- PASS: `npm run test:database` (159 tests)
- PASS: `npm run typecheck:contracts && npm run typecheck:services && npm run typecheck:database`
- PASS: `npm run lint:contracts && npm run lint:services && npm run lint:database`
- PASS: `npm run scan:framework-standards:ratchet` (0 findings)
- PASS: `git diff --check`

## Spec Compliance

- Related specs reviewed: none.
- Alignment: implemented the provider/source/connection split, normalized adapter contract, exact activation compatibility gate, source-owned persistence and cursors, immutable run and revision pins, request fencing, diagnostic retention, and source-neutral identity model as specified.
- Divergences: none. The legacy ingestion runtime remains intentionally unwired to these replacement tables until tasks 004, 006, and 007 complete the planned clean cutover; no compatibility read or dual-write path was added.
- Verification: the commands above plus a final independent P1/P2 audit after the direct-PostgreSQL semantic-content guard, canonical replay normalization, immutable-history guards, and derived EV-input origin constraint were implemented; no P1/P2 finding remains.
