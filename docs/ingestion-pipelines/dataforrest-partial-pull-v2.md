# DataForrest partial-pull relationship compatibility plan

Status: approved incident remediation for the local Collector Crypt and
ClutchPacks backfill

Owner: PackScout data platform

## Exact legacy boundary

`packscout.provider-observation.v1` defines a pull as one pack relationship
and one card relationship. DataForrest event adapters v1 and v2 therefore
accept only nonblank `pack_id` and `card_id` values. Those versions and their
historical source revisions remain immutable.

During the 2026-08-25 backfill, DataForrest delivered 1,745 ClutchPacks pulls
with a nonblank card ID and `pack_id = null`. It also delivered 18,616 Collector
Crypt spin pulls with a nonblank pack ID and `card_id = null`. Both sets retain
a stable pull record ID. There is no authoritative value for either missing
relationship, so PackScout must not infer or fabricate one.

## Additive contract

The replacement path introduces all of the following as new exact pins:

- a normalized observation v2 contract and semantic-hash version;
- DataForrest adapter v3, whose raw pull shape requires both relationship keys,
  permits each ID to be nullable, and rejects a pull when both are null;
- mapper v2 descriptors that consume only normalized observation v2; and
- persistence validation selected by the exact normalized-contract pin.

Observation v2 requires at least one relationship and permits at most one pack
and at most one card relationship. Relationship order remains canonical: pack
before card when both exist. Existing observation v1, adapter v1/v2, mapper v1,
and stored semantic identities are neither widened nor reinterpreted. Unknown
version tuples fail closed; there is no fallback, dual write, or provider-name
branch in generic orchestration.

A one-sided pull is canonical with only the edge DataForrest supplied. A
card-only pull cannot contribute to pack-scoped Heat, EV, or pack attribution.
A pack-only pull retains its pack relationship but has no card attribution.
Downstream behavior must use only present edges until the provider supplies an
authoritative missing identity.

## Migration and reset strategy

Collector Crypt and ClutchPacks each use a separately encrypted and tested
DataForrest v3 connection profile so upgrading either source cannot repin the
other. At an operator-approved safe page boundary for each affected source,
operators:

1. request its audited pause without changing its committed cursor;
2. create and test a replacement source with the same identity namespace and
   record-ID scopes, but the explicit v3/v2/v2 adapter-contract-mapper tuple;
3. activate the replacement paused, then resume it from Feed start; and
4. reconcile provider outcomes and canonical catalog, pull, and market-event
   counts at provider head.

The replay is required because adapter-invalid legacy quarantines retain the
exact native payload but have no normalized observation or semantic identity,
so the ordinary mapper-only quarantine retry cannot repair them. Replayed
existing records deduplicate by their stable scoped provider identity; the
previously rejected one-sided pulls become canonical without fake edges.

## Removal trigger

Historical v1/v2 resolvers may be removed only after an operator proves that no
source revision, retained run, request attempt, quarantine, or replayable page
still pins them and records that retirement in a separately reviewed migration.
Until then they are historical readers, not an alternate current source of
truth.
