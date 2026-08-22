# Feature: DataForrest Platform Source Integration

## Start Here

Open task `dataforest-source-integration/001` and capture one sanitized authenticated Courtyard page plus one continuation page. The first evidence milestone confirms the request shape, cursor behavior, bounded response size, and safe parallel-request limit without exposing the bearer credential or provider data.

**Progress:** 9/10 tasks complete

## Context

PackScout must replace its obsolete aggregate and speculative multi-stream feed assumptions with DataForrest's live `GET /v1/events` cursor feed. The dated provider baseline contains about 14.5 million records across Courtyard, Collector Crypt, Phygitals, and ClutchPacks. DataForrest supplies full history plus ongoing records from one endpoint.

The stable business objects are the four PackScout platforms/providers. Each provider has its own replaceable source instance, opaque cursor, schedule, runs, health, and processor log feed. The four first-pass source instances share one DataForrest connection profile and one DataForrest adapter. DataForrest is an implementation of the provider-source boundary, not the boundary itself.

The first pass runs locally through one long-lived supervisor process. It owns four concurrent platform lanes, while PostgreSQL remains authoritative for schedules, queued runs, leases, cursors, progress, and restart recovery. The admin console configures and monitors those lanes; it does not run imports in the browser or create a second scheduler.

## Authoritative Architecture

```text
                           ADMIN CONSOLE
                generic source lifecycle / monitoring
                                  |
                                  v
+--------------------------------------------------------------------+
|                    POSTGRES CONTROL PLANE                          |
|                                                                    |
|  Stable provider       Active source instance       Source type    |
|  Courtyard ----------> courtyard-source ----> dataforrest-events-v1 |
|  Collector Crypt ----> collector-source ----> dataforrest-events-v1 |
|  Phygitals ----------> phygitals-source ----> dataforrest-events-v1 |
|  ClutchPacks --------> clutchpacks-source --> dataforrest-events-v1 |
|                                                                    |
|  Per source: adapter revision/config, opaque cursor, schedule, |
|              runs, lease, health, and diagnostic feed              |
|  Per profile: adapter type, encrypted config, tests, request limit |
+---------------------------------+----------------------------------+
                                  |
                                  v
+--------------------------------------------------------------------+
|                 ONE FENCED LOCAL SUPERVISOR                        |
|                                                                    |
|  Four concurrent provider lanes --> generic source runtime         |
|                                      + source-adapter registry     |
+---------------------------------+----------------------------------+
                                  |
                 +----------------+----------------+
                 |                                 |
                 v                                 v
       DataForrest adapter                 Future adapters
       shared client/libraries       PackScout service / third party
       (first pass)                        (not first pass)
                 |                                 |
                 +----------------+----------------+
                                  v
              normalized provider-observation page
   records + opaque cursor + continue/poll-after + safe evidence
                                  |
                                  v
              provider mapper --> generic atomic importer
                                  |
                                  v
               canonical data + EV work + cursor
```

A provider identity never contains a source-instance, source-adapter, or connection-profile identity. Replacing `courtyard-dataforest` with a future `courtyard-packscout-collector` creates a new source with its own cursor and changes only Courtyard's active source binding. The replacement must declare the same Courtyard identity-namespace key and emit stable IDs from that namespace; an incompatible source cannot activate without a separately designed identity-migration feature.

## Resolved Decisions: Source Model

- Courtyard, Collector Crypt, Phygitals, and ClutchPacks are the only first-pass providers, using exact filters `courtyard`, `collector_crypt`, `phygitals`, and `clutchpacks`.
- One shared DataForrest connection profile owns the HTTPS endpoint, encrypted bearer credential revisions, request bounds, and supported aggregate request concurrency.
- Each provider owns one active source instance with an immutable platform filter and independent opaque cursor, 60-second default interval, run history, health, and processor log feed.
- A provider source is replaceable; canonical business identity remains organization plus stable provider plus canonical kind plus provider record identity, while identity namespace is a compatibility gate on the source revision.
- GameStop, Beezie, Trove, and Stadium Vault remain compiled reference mappings but are not registered or configurable as DataForrest launch sources.

## Resolved Decisions: Source Adapter Boundary

- `sourceTypeKey` identifies one compile-time source-adapter registration; generic scheduling, lifecycle, imports, persistence, and admin operations use that key and never branch on DataForrest, platform names, endpoints, SDKs, or vendor page fields.
- A source adapter owns its configuration validation, credentials, upstream client or library, connection and source tests, pagination translation, cancellation, and safe failure classification; it declares capacity needs but cannot acquire or bypass connection permits itself.
- Every adapter returns the same normalized provider-observation page: stable provider and record identities plus evidence-backed record-ID scope, ordered record outcomes, an adapter-owned opaque cursor, either `{ kind: continue }` or `{ kind: poll_after, minimumDelaySeconds }`, bounded measurements, and sanitized diagnostics.
- Every source revision separately pins a `mapperKey` and version compatible with its stable provider, normalized contract, and identity namespace; mappers consume normalized observations and never import DataForrest types or choose behavior by source type.
- Production registers only `dataforrest-events-v1`; test composition registers one alternate adapter that proves the generic runtime and importer do not depend on DataForrest.

## Resolved Decisions: Future Source Replacement

- Every source instance owns its `sourceTypeKey`, adapter and normalized-contract revisions, mapper key and version, identity namespace, connection-profile revision, source configuration revision, cursor codec, opaque cursor value, and cursor generation.
- Cursors never move between source instances or adapter types; a replacement source starts with its own null cursor and establishes its own continuation state independently.
- A future PackScout-owned or third-party adapter may replace one provider without changing the other providers, scheduler, importer, persistence, or generic admin commands.
- It reuses the provider's mapper when normalized contract and identity namespace match; changed normalized meaning requires a separately registered mapper version, not a source-type branch in generic code.
- A replacement must preserve the provider's identity-namespace key and stable record IDs. A mismatch blocks activation and requires a separately approved identity-migration and reconciliation feature.

## Resolved Decisions: Contract Authority

- One versioned provider-source contract is the sole authority for adapter capabilities, normalized observations, opaque cursors, continuation, identity, lifecycle, failure, and diagnostic semantics.
- One versioned DataForrest adapter contract is the authority for its filters, raw page wrapper, event vocabulary, pagination hints, request bounds, and connection-scoped concurrency.
- Generic worker, server, admin, migration, and test consumers use only the provider-source contract; only the DataForrest adapter and its evidence fixtures consume the vendor contract.
- Source, profile, run, page, diagnostic, and completion evidence pins both applicable contract revisions rather than copying their defaults.
- A live-evidence contradiction creates a reviewed DataForrest adapter-contract revision; it cannot create a vendor or provider branch in generic code.

## Resolved Decisions: Processing

- One page may contain catalog, pulls, and trades for one platform; its opaque cursor belongs only to that source instance and adapter revision.
- The local supervisor exposes four concurrent platform lanes and holds one durable singleton lease; a second process fails before claiming work or invoking a source adapter. One source may have one active run and one in-flight page request, while different providers may run together.
- A slow, backlogged, paused, or failed provider cannot block another provider's scheduling, fetch, mapping, commit, retry, or health transition.
- A generic process-local coordinator admits reads and tests only when both an execution slot and the stable profile's cancelable FIFO permit are grantable, so no operation holds one while waiting for the other. After paired grant, one authoritative guard revalidates active singleton, job or run, profile/revocation/health, source/lifecycle, and cursor-generation fences before issuing a one-use request lease; stale work releases both resources and makes zero calls. Bounded response capture or normalized request-failure classification closes the lease before page normalization, but a typed connection-blocking outcome must persist its episode and health generation before waking another waiter. Task 001 must prove at least two safe concurrent requests.
- Each page atomically commits evidence, outcomes, canonical and EV changes, normalized continuation, and next cursor only after a generic source-generation guard rejects any previously committed `continue` cursor fingerprint.

## Resolved Decisions: Scheduling and Recovery

- Each provider defaults to polling every 60 seconds after reaching head and may be configured independently from 60 seconds through 24 hours; it remains fresh until its next due time plus a fixed 15-minute grace.
- The DataForrest adapter translates `poll_after_seconds = 0` to `continue` and `60` to `poll_after` with a 60-second minimum; generic scheduling continues fairly or waits for the greater of the source interval and adapter minimum without reading vendor poll fields.
- Scheduled, continuation, and manual work reuse durable schedules and queued import runs; no second work-intent subsystem is introduced.
- A manual request becomes due immediately and coalesces with pending or running work for that provider instead of creating a duplicate run.
- Worker restart, timeout, pause, retry, and disable resume only from a committed opaque cursor; no failure silently restarts a source from the beginning.

## Resolved Decisions: Records

- Internal source kinds are catalog, pull, and trade. Canonical kinds are pack, generic catalog asset with card type, pull, and market event.
- Existing canonical platform, EV input, and estimated-EV kinds remain. The obsolete canonical sale kind becomes market event, while `sale` remains a valid event-type code.
- The nine known event codes are `sale`, `buyback`, `mint`, `burn`, `transfer`, `list`, `unlist`, `swap`, and `ship`; DataForrest's outer code wins over provider-native wording.
- Currency remains a ticker and `payment_method` remains separate nullable metadata. `record_id`, not a transaction hash, is source identity.
- DataForrest `available` maps true to available, false to unavailable, and null to unknown. False never means sold out.

## Resolved Decisions: Observation Identity

- The normalized contract freezes a `recordIdScopeKey` for every provider record shape; stable source-record identity is organization, source instance, scope, and provider record ID, so legitimate cross-scope ID reuse does not collide.
- Kind or pack/card discriminator changes inside one frozen scope are identity conflicts. A replacement adapter must emit the same scopes and provider IDs under the compatible provider identity namespace.
- A semantic observation is unique by stable source record, effective source time, normalized-contract/hash version, and normalized-content hash.
- Every page delivery has a separate page-and-record-index occurrence with full adapter, connection, mapper, collection, evidence, and disposition lineage; replay adds an occurrence without duplicating semantic or canonical state.

## Resolved Decisions: Diagnostics and Admin

- Every platform processor emits its own chronological diagnostic feed. Correlation follows event kind: lifecycle uses command or audit context, tests use exactly one operation-specific test-job context, runs and pages use their durable IDs, and shared connection events use profile-episode context without fabricated source or run values.
- The feed records lifecycle, schedule, fetch, validation, mapping, commit, retry, pause, recovery, and failure events with severity, safe codes, timings, and bounded counters.
- Processor feeds retain 30 days of sanitized page/run events. They never contain credentials, payloads, personal identifiers, full cursors or vendor cursors, authorization headers, or raw upstream bodies.
- Normal success logging is page-level rather than per-record. Record-level failures live in quarantine to prevent a 14.5-million-record log explosion.
- Admin shows each provider's progress and feed independently and supports Run now, Pause/Resume, Retry, and interval changes under existing role permissions.

## Resolved Decisions: Failure Ownership

- Shared credential, authorization, endpoint, TLS, destination, or profile-configuration failure advances a connection health generation and is stored once as a blocking connection-revision episode; queued and uncompleted bound operations are fenced, at most one recovery attempt is pending or running with duplicate coalescing and retry after failure, each source preserves its cursor, and source-local failures remain isolated.
- Every upstream call has a sanitized durable pre-call attempt that must terminalize before permit wake or downstream work. A pre-call insert failure releases paired resources, makes zero calls, and self-fences. The versioned contract allows three transaction attempts with 100/400 ms backoff, 750 ms per-attempt timeout, and a three-second hard limit. Exhaustion self-fences locally and attempts an `active` to `fenced_draining` database CAS; after a successful CAS no captured page or test result may commit, while an unavailable CAS stops renewal and persistence and leaves takeover to reconcile any transaction already submitted under the predecessor epoch. The next owner atomically terminalizes nonterminal attempts from any released, superseded, or expired-through-grace predecessor as uncertain and opens or coalesces one blocking episode before any new call.

## Resolved Decisions: Retention and Safety

- Store one authoritative protected raw page copy for seven days; do not duplicate the full raw payload on both page and source-record rows.
- Retain quarantined record evidence for 30 days so operators can diagnose and retry it after the page-level raw copy expires.
- Preserve canonical history, compact record dispositions, hashes, relationships, EV work, cursors, run summaries, health, and operator audits durably.
- Before a full backfill, measure a representative PostgreSQL sample and require enough approved capacity for the projected normalized history, indexes, seven-day raw window, 30-day quarantine, 30-day processor logs, 30-day terminal request attempts, and permanent compact attempt lineage.
- Secrets are loaded once through the existing encrypted admin credential workflow; the evidence-only plaintext token is unset before the supervisor starts, and worker or browser responses never expose it.

## Resolved Decisions: Admin Experience

- The overview presents one shared connection and four provider rows with processor state, head/backfill state, pages, records, throughput, elapsed time, last progress, next due time, health, and quarantine count.
- A provider detail presents current source configuration, run history, safe cursor fingerprints, page progress, retry state, and its isolated processor log feed.
- The log feed refreshes every five seconds while visible, supports severity, phase, and run filters, and uses bounded keyset pagination; operators may pause display refresh without pausing ingestion.
- ETA or percent complete appears only when a defensible provider-specific total exists. Otherwise the console states that the total is unknown and shows elapsed time and throughput.
- Loading, empty, delayed, running, retrying, paused, failed, reached-head, forbidden, and recovery states remain distinct and accessible without relying on color.

## Abstraction Success

- Compile-time boundary checks prevent generic lifecycle, scheduler, importer, persistence, mapper-selection, and admin-domain code from importing DataForrest wrappers, cursor fields, polling fields, clients, or SDK types.
- A test-only alternate Courtyard adapter with different raw pagination passes connection test, source test, continuation, resume, mapping, atomic import, and profile-capacity coverage through the unchanged generic runtime.
- Production and admin registries expose only `dataforrest-events-v1`; dynamic plugins, cursor translation, dual-source cutover, and incompatible-ID reconciliation remain out of scope.

## First-Pass Success

- All four platform processors can run concurrently and independently from the same local supervisor without sharing cursors, leases, log events, or failure state.
- Each provider completes its full historical backfill, reaches head, survives a restart from its committed cursor, and returns to its independently configured incremental schedule.
- Every delivered record receives exactly one durable disposition, and unresolved mapping, identity, immutable-conflict, or relationship failures are zero at final reconciliation.
- The admin console can diagnose and operate every provider from its own progress and log feed without exposing protected data.
- Actual backfill duration, throughput, storage, memory behavior, and incremental latency are recorded; `npm run verify:framework` passes without a bypass or new baseline.

## Out of Scope: Runtime and Hosting

- Vercel deployment, Vercel Cron, Vercel Workflow, or another production worker host.
- Concurrent active supervisor processes or cross-process DataForrest capacity sharing; first pass enforces one active owner with a durable singleton lease.
- One operating-system process per platform; first-pass isolation is provided by four concurrent source lanes and durable leases.
- A second in-memory scheduler or queue alongside PostgreSQL.
- Production paging, email, Slack, or incident-delivery integrations.

## Out of Scope: Product and Data

- A certification, publication-eligibility, approval, revocation, or rollback ledger specific to this ingestion feature.
- A raw provider-payload browser or one diagnostic log row per accepted record.
- Launching deferred providers, implementing a live PackScout-owned or third-party source adapter, or reconciling a future source whose identity namespace differs from DataForrest; only the generic seam and test-only alternate adapter are in scope.
- Redesigning PackScout EV methodology or publishing raw market events and payment methods publicly.
- Compatibility reads, dual writes, old aggregate pages, `has_more`, or three independent DataForrest cursors.

## External Dependencies

- An authorized DataForrest bearer credential must be supplied through an ignored local secret and then bootstrapped into the existing encrypted credential workflow.
- DataForrest must continue supporting the documented platform-filtered cursor contract and at least two safe concurrent requests.
- The local PostgreSQL environment must have approved capacity for the measured full-history forecast before task 010 starts the real backfill.
- The production canonical-to-public publisher is a separate unimplemented prerequisite for live DataForrest availability; this feature supplies its versioned availability contract and verified public UI readiness without claiming live publication.

## Tasks

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 001 | Prove the live contract and launch bounds | medium | 1–2 days | done | none |
| 002 | Establish provider-source contracts and persistence | large | 3–4 days | done | 001 |
| 003 | Read DataForrest pages through the source adapter | medium | 3–4 days | done | 002 |
| 004 | Configure and activate platform sources | medium | 2–3 days | done | 003 |
| 005 | Map four platforms into canonical data | large | 4–5 days | done | 002 |
| 006 | Import mixed pages atomically | large | 3–4 days | done | 003, 005 |
| 007 | Run parallel platform processors | large | 4–5 days | done | 004, 006 |
| 008 | Monitor and operate platform processors | large | 3–5 days | done | 007 |
| 009 | Expose trustworthy pack availability | medium | 2–3 days | done | 005 |
| 010 | Bootstrap, backfill, and reconcile | large | 2–4 days plus live backfill | blocked | 008, 009 |

Total estimated builder effort is 27–39 days, including focused verification but excluding external credential delays.

## Build Order

1. Complete task 001 and record the evidence-backed request and capacity bounds.
2. Complete task 002; tasks 003 and 005 can then run in parallel.
3. After task 003, task 004 can proceed; after tasks 003 and 005, task 006 can proceed. Task 009 can proceed after task 005.
4. Complete task 007, then task 008, while task 009 finishes independently.
5. Complete task 010 only after the operational admin console and availability handoff are ready.

## Parallel Groups

| Group | Ready when | Tasks |
|---|---|---|
| A | immediately | 001 |
| B | 001 complete | 002 |
| C | 002 complete | 003, 005 |
| D | 003 complete | 004 |
| E | 005 complete | 009 |
| F | 003 and 005 complete | 006 |
| G | 004 and 006 complete | 007 |
| H | 007 complete | 008 |
| I | 008 and 009 complete | 010 |

## Next Action

Provision a dedicated local PostgreSQL backing volume with at least
8,759,332,238,475 available bytes and less than 80% used. Then supply the
authorized bearer only through the encrypted admin workflow and execute task
010's guarded runbook, live backfill, operational proof, and reconciliation.
