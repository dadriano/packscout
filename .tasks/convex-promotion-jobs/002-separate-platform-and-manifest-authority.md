# Task: Separate Provider and Central Manifest Authority

**ID:** convex-promotion-jobs/002
**Depends on:** distributed-canonical-warehouse/014, distributed-canonical-warehouse/015
**Blocks:** convex-promotion-jobs/003, convex-promotion-jobs/004
**Status:** todo
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

- [ ] Provider A can publish only Provider A and cannot activate a manifest.
- [ ] Provider B's credential, database, release, or status proof is rejected
  before Provider A mutation.
- [ ] The central job can perform only
  `advance | add | remove | rollback` and cannot publish provider bytes.
- [ ] Missing, extra, stale, target-drifted, cross-scoped, or malformed
  authority fails startup/admission without durable false progress.
- [ ] Current and previous rotation keys reconcile exact historical receipts;
  old authority can be retired independently.
- [ ] Central outage never prevents a valid provider completion transaction.
- [ ] No production composition instantiates the legacy composite promotion
  authority.

## Verification

Run focused configuration/authority/status/key-rotation tests, provider and
central database readiness tests, Convex security tests, worker typecheck/lint,
and the framework boundary ratchet.

## Spec Compliance

Provider is the canonical internal term. Existing Convex public-contract field
names may be adapted only at the transport boundary.
