# Distributed records-per-request settings

## Approved behavior

The distributed provider path restores the operator-managed request sizing from
PR #37 without reusing the legacy source database. A provider-local immutable
setting revision holds an integer from 1 through 5,000. Its active pointer is
independent of the central source configuration, schedule, runtime generation,
and source checkpoint. Saving a setting changes none of those values.

Each new run pins the setting revision and record count transactionally. A
queued or running import continues with its original pin; automatic recovery
copies the parent pin. A subsequent independent run uses the current setting.
Both source admission and page commit enforce the run's bound. A smaller or
empty upstream response is valid; the number is a maximum, not a promise.

The adapter manifest's existing `pageLimit` remains the historical/default
value. The explicit distributed request policy supplies the supported maximum
separately. Legacy adapter construction, connection tests, and old inspection
paths keep their manifest bounds. Request sizing does not relax byte, timeout,
parser-node, depth, field, or canonical validation limits.

The existing isolated canonical-page cap remains 4,000 normalized records. One
source record may expand into several canonical records (for example a pack and
its category). The request pin is enforced against the source count, not this
expanded count. A configured maximum of 5,000 does not guarantee a 5,000-record
response fits the independent canonical-page or byte bounds; such responses
still fail closed. The requested 1,000 setting does not change those bounds.

## Authority and audit

- Admin mutations require an authenticated operator with source-management
  permission in the provider's organization, same-origin protection, a matching
  provider/source identity, and the exact current central/cached configuration.
- A save compares the expected active request-setting revision. A stale editor
  receives a structured conflict and must reload; it cannot overwrite a newer
  revision silently.
- Revision provenance identifies the config/adapter present when it was created.
  It does not replace current configuration authority checks.
- Run pins and setting revisions are immutable. The setting save and its audit
  record are atomic. No credential, raw source payload, or raw cursor is exposed.

## Additive rollout and historical boundary

Existing runs have unknown request-setting revisions. The migration leaves their
nullable pins untouched; it never fabricates historical values. Existing frozen
workers may continue on **uninitialized** providers. Once a provider has settings,
new runs must carry pins, and the new worker refuses an unpinned historical run
before making a source request. Existing null-pin rows are not rewritten.

Protected file-capture sources explicitly declare an unmanaged request-settings
capability: they have no live source request to size or attest. Only an
uninitialized provider with both run pins absent may use that capability; once
settings exist, the same capture execution is refused rather than borrowing a
DataForrest pin or fabricating a source-count receipt. Generic callers default
to required pins, and live DataForrest sources cannot opt out. Capture pages
retain their independent canonical and byte bounds. Initial settings creation
must wait for all unmanaged active work to drain.

This rollout boundary is owned by the distributed ingestion work. Its removal
condition is a coordinated handoff of every legacy manifest-bound provider
writer to the pin-aware worker and explicit settings initialization for those
providers. Until then, Admin labels uninitialized providers as adapter-managed
and does not advertise an editor that their current worker would ignore. A
missing database, identity mismatch, or incoherent config is unavailable, never
an implicit initialization or fallback to a different database.

The requested initial rollout is Phygitals only, at **1,000 records per request**.
Other provider settings and workers remain unchanged. Additive schema rollout
must preserve existing provider-specific migrations and use bounded lock waits.
The updated Admin reads the new columns on all four isolated provider databases,
so each needs the additive schema before the Admin-only cutover. This does not
initialize the other providers' settings. Their editor and Run now action remain
unavailable until a separate pin-aware writer handoff; existing frozen workers
continue independently. New settings revisions receive SELECT/INSERT privileges
only; the current-revision pointer additionally permits UPDATE.

## Acceptance evidence required

1. Settings accept integer bounds 1 and 5,000; reject zero, fractions, oversized
   values, malformed input, wrong organization/source, and stale revisions.
2. Saving changes only setting/audit state, with source config, schedule,
   checkpoint and runtime generation unchanged.
3. New runs pin current settings; already queued/running runs and recovery retain
   their original pins after a save. Unknown historical pins remain unknown.
4. The request and interpreter use the durable pin; an over-limit response is
   rejected before canonical rows, page ledger, or checkpoint are committed.
5. Existing manifest-bound paths and byte/timeout/parser protections retain their
   prior behavior. Uninitialized providers remain explicit and read-only.
6. Admin shows configured size separately from the active/latest run's recorded
   size, and supports a successful save plus a stale-editor conflict reload.
7. Focused real PostgreSQL tests, component/route/worker tests, and the complete
   `npm run verify:framework` gate pass in the isolated checkout.
8. The Phygitals handoff verifies no competing owner, preserves the full committed
   checkpoint, initializes 1,000, queues one audited new run, and verifies its
   durable request pin and committed progress. Other workers/services stay up.

## Live handoff constraints

Only the centrally resolved local topology is authorized: central
`127.0.0.1:55431/packscout` and its four isolated provider databases on
`55432` through `55435` for the additive migration, grants, and read-only
verification. Settings initialization and the writer handoff apply only to
Phygitals at `127.0.0.1:55435/packscout_phygitals`.
Resolve and validate organization, provider,
configuration, database identity, credentials, and current lease/run state before
any mutation. Never use the old `5432` import runtime.

`scripts/local/initialize-provider-request-settings-local.mts` initializes
settings only; it does not resume, queue, or launch an import. The historical
null-pin Phygitals run cannot use ordinary pin-preserving retry. An audited new
independent run at its identical committed checkpoint is a separate reviewed
handoff step after initialization.

Phygitals' prior catch-all execution failure is retained history, not proof that
request sizing caused or fixes that failure. Do not add it to the transient retry
allowlist. A bounded source canary may validate the requested size at the exact
saved checkpoint, but must not write or advance it. If the unchanged byte/time
limit rejects the larger page, report that specific blocker rather than silently
raising another limit. If an unknown/permanent failure recurs, stop and preserve
its diagnostics; do not reset or replay the import.

The paused conversational monitoring automation remains paused. No Convex
publication, backend replacement, frontend change, or unrelated worker restart
is part of this request.
