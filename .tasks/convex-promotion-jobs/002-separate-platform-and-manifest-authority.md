# Task: Separate Provider and Central Manifest Authority

**ID:** convex-promotion-jobs/002
**Depends on:** distributed-canonical-warehouse/014, distributed-canonical-warehouse/015
**Blocks:** convex-promotion-jobs/003, convex-promotion-jobs/004
**Status:** done
**Companion spec:** tech-001-distributed-promotion-jobs.md

## Objective

Make provider publication and manifest activation separate least-authority jobs
with trusted server routing and no shared credential or composite database
client.

## Requirements

- A provider job is pinned to one trusted `providerId`, opens exactly its
  verified provider database, and receives only that provider's Convex
  publication authority.
- The central manifest coordinator receives only manifest status/activation
  authority. It has no provider publication or provider database credential.
- Provider commands never accept provider key, database name, URL, host, secret,
  organization, or deployment as caller-selected authority.
- The central job derives organization/provider ownership from the registry and
  uses the bounded provider gateway only for exact proof reads.
- Credential overlap supports rotation within one role. A key for one provider
  cannot publish another provider or activate a manifest.
- Startup proves database role/identity/schema, configured endpoint, signed
  remote state, and exact role assignment before mutation.
- Provider completion remains valid during central outage; the outbox is the
  only bridge. Central manifest work never rolls back provider completion.
- There is no manifest clear authority or legacy composite compatibility mode.

## Acceptance Criteria

- [x] Provider A can publish only Provider A and cannot activate a manifest.
- [x] Provider B's credential, database, release, or status proof is rejected
  before Provider A mutation.
- [x] The central job can perform only
  `advance | add | remove | rollback` and cannot publish provider bytes.
- [x] Missing, extra, stale, target-drifted, cross-scoped, or malformed
  authority fails startup/admission without durable false progress.
- [x] Current and previous rotation keys reconcile exact historical receipts;
  old authority can be retired independently.
- [x] Central outage never prevents a valid provider completion transaction.
- [x] No production composition instantiates the legacy composite promotion
  authority.

## Verification

Run focused configuration/authority/status/key-rotation tests, provider and
central database readiness tests, Convex security tests, worker typecheck/lint,
and the framework boundary ratchet.

## Spec Compliance

- Related specs reviewed: `tech-001-distributed-promotion-jobs.md`
- Alignment: provider and manifest authorities are split, routed by trusted
  server configuration, and fail closed without a legacy composite fallback.
- Alignment detail: startup requires a current trusted bootstrap and fails
  closed when it cannot obtain one. After startup, a resident provider retains
  its last verified pin through a transient central outage. A durable cold-start
  cache was not part of the approved contract and would require separate
  revocation, expiry, and storage semantics.
- Capacity boundary: bootstrap accepts at most 50,000 records per retained
  section and 128 MiB on the wire. Larger graphs fail closed and require a
  future streaming-to-persistence design; the maximum-count representative
  graph passes the real worker consumer under 256 MiB V8 old-space, and every
  section rejects a declared or produced 50,001st record.
- Authority capacity: publication configuration accepts the 64-provider roster
  with one distinct 32-byte provider key each plus all 24 ancillary authority
  slots in 6,029 UTF-8 bytes. It permits at most two current/previous keys per
  provider while enforcing Convex's independent 8 KiB secret-map limit, so
  rotations remain bounded across a full roster. Provider 65, a third key for
  one provider, and an 8,193-byte map fail closed.
- Verification: focused authority, relay, rotation, worker, and framework
  checks pass.
- Completion: split authority, trusted routing, rotation overlap, outage
  continuity, and legacy-composition exclusion are covered by focused and full
  repository verification. Live cutover evidence remains Task 009 work.
