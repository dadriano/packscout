# DataForrest ClutchPacks card adapter v2

Status: retained adapter-v2 contract; superseded for new revisions by adapter v3

Owner: PackScout data platform

## Corrected V1 source semantics

DataForrest's endpoint and raw record envelope remain V1. Adapter-v2 revisions
use `dataforrest-events-adapter-v2`, normalized observation
`packscout.provider-observation.v1`, and ClutchPacks mapper revision `1`.

For a ClutchPacks `catalog` / `card` record, adapter v2 reads only this exact
`data.asset` allowlist:

- `title` as the canonical display name;
- `description` as the canonical description;
- `subtype` as the canonical category;
- the full, medium, and thumbnail front/back image URL fields, in that order,
  with duplicates removed; and
- `formatted_current_price` as strict nonnegative USD display money, with
  value source `clutchpacks_formatted_current_price`.

The outer `record_id` remains authoritative identity. Nested IDs, `name`,
`type`, `year`, `set`, card number, grading, certificate, owner, and all other
native fields remain protected provenance and cannot change canonical identity
or content.

## Deliberate legacy registration

Adapter v1 read ClutchPacks card display names only from top-level
`data.provider_label`; it did not expose `data.asset`. Existing connection,
source, cursor, run, and page rows pin that exact interpretation, so the
production registry retains adapter v1 rather than silently changing its
meaning. Adapter v3 is now the only version advertised when creating a
revision; adapters v1 and v2 remain registered for their exact pinned history.
There is no fallback, dual write, or generic provider branch.

The adapter-v1 registration may be removed only after no active, paused,
queued, running, or recoverable connection/source work is pinned to adapter v1
and the data-platform owner confirms historical operations no longer need to
interpret adapter-v1 evidence. The adapter-v2 registration has the same removal
gate for adapter-v2 work and evidence; it must remain until every such pin is
gone and the data-platform owner explicitly retires that historical
interpretation.

## ClutchPacks replay

Do not reinterpret an adapter-v1 import page in place. More importantly, do not
replay adapter v2 into an organization whose canonical identity space already
contains adapter-v1 ClutchPacks history. Catalog revision ordering uses provider
effective time and a deterministic content-hash tie-break. The same provider
record replayed through v1 and v2 normally has the same `occurred_at`, so v2 is
not guaranteed to become current merely because it was collected later.

A clone, snapshot, organization, or database containing any adapter-v1
ClutchPacks lineage is therefore not a valid replay target. Do not use a new
tenant in the active `packscout_dev` database. The supported rehearsal shape is
two different local PostgreSQL databases:

- the active source database is read only for the exact v1 Clutch connection and
  pause/drain evidence; and
- the target is a fresh, separately named database with zero organizations,
  providers, connection/source revisions, import runs/pages, and canonical
  entities before bootstrap.

The target must be migrated from the integrated code line containing both
`20260827010000_provider_source_platform_request_lanes` and this change's
`20260826005000` / `20260826010000` migrations. Do not run the bootstrap from a
revision that lacks that integration. The bootstrap checks the exact
platform-lane migration and checksum in the source, and all three exact migration
checksums plus 88 application tables in the target. The normal database-readiness
manifest must cover that same combined migration set.

Use the guarded local bootstrap to stage that empty target:

```bash
# Protected environment; use the existing local encryption key without printing it.
export NODE_ENV=development
export PACKSCOUT_RUNTIME_ENVIRONMENT=local
export PACKSCOUT_CLUTCHPACKS_V1_DATABASE_URL='<active-local-source-url>'
export PACKSCOUT_DATABASE_URL='<fresh-local-target-url>'
export PACKSCOUT_CLUTCHPACKS_V1_ORGANIZATION_ID='<source-org-uuid>'
export PACKSCOUT_CLUTCHPACKS_V2_CANARY_ORGANIZATION_ID='<new-target-org-uuid>'
export PACKSCOUT_CLUTCHPACKS_V2_TARGET_ACK=\
'I_UNDERSTAND_THE_TARGET_MUST_BE_A_FRESH_LOCAL_DATABASE'
export PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64='<protected-existing-local-key>'
export PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION='<existing-key-version>'

npm run bootstrap:clutchpacks-v2-canary:local -- --dry-run

npm run bootstrap:clutchpacks-v2-canary:local -- \
  --execute \
  --confirmation "BOOTSTRAP CLUTCHPACKS V2 LOCAL <digest>"
```

The command copies the active ClutchPacks DataForrest connection only inside
the process: it decrypts the source revision under its original tenant scope,
validates it, and encrypts a new adapter-v2 revision under the canary tenant
scope. It never prints the bearer credential or plaintext configuration. It
also creates only the active identity-only ClutchPacks provider root (with no
legacy provider configuration revision), a draft v2 source with cursor
generation 1 at Feed start, and a profile with the governed DataForrest
`requestLimit: 2`. Replay still runs with one supervisor execution slot, so the
canary issues at most one provider request at a time. It uses a
programmatic system actor and creates no administrator or password. It does not
queue a test, call DataForrest, pause either database, activate the source, or
start replay.

Qualify and run the target through the guarded driver and its dedicated
[operator runbook](./clutchpacks-v2-local-canary-runbook.md). The required order
is:

1. Pause the original ClutchPacks source at a completed page boundary and prove
   it has zero queued or running import runs. Collector Crypt, Courtyard, and
   Phygitals may remain active: the integrated request lanes enforce DataForrest's
   cap of two requests per platform, not one aggregate cap per credential.
2. Re-run the bootstrap dry-run and require
   `replayCapacityReady: true`. Cross-database permits and supervisor advisory
   locks are database-local; do not treat them as coordination between source
   and target.
3. Start exactly one source supervisor built from the integrated code line,
   pointed only at the target database, with exactly one execution slot.
4. Use one digest-confirmed driver transition at a time to test and activate the
   target connection, test and activate the target source in `paused` state, and
   finally resume that source from Feed start. The original database's ordinary
   worker may keep serving the other three platform lanes while original Clutch
   remains paused.
5. Run until the exact v2 source revision reports a successful run at provider
   head. Reconcile provider head, exact external-ID set equality, nonblank card
   names, and release-assembly dry-run before publication. Stop the target
   supervisor and pause the target source before generating the immutable public
   catalog candidate.
6. Bind canary approval and Clutch-only promotion to the target organization
   through `PACKSCOUT_PUBLIC_ORGANIZATION_ID`. Do not select the original
   organization or include any other provider in the release source set.

The v2-only target creates fresh semantic and canonical revisions while
preserving stable provider identity. If Feed start cannot replay the complete
catalog, stop: replaying retained protected pages under a new source revision
needs a separately reviewed migration tool with exact lineage and page-commit
invariants. Existing tooling cannot transfer retained pages across their exact
run, source revision, connection revision, adapter version, and cursor pins.
Selective SQL updates to canonical JSON, substituting `collected_at` for provider
effective time, replaying retained pages through ordinary tooling, and replay
into any v1-bearing target are not acceptable backfills.
