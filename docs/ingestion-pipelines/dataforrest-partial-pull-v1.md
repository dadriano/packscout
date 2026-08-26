# DataForrest V1 partial-pull relationship contract

Status: current production contract and approved incident remediation for the
local Collector Crypt and ClutchPacks reimport

Owner: PackScout data platform

## Provider evidence

During the 2026-08-25 backfill, DataForrest delivered 1,745 ClutchPacks pulls
with a nonblank card ID and `pack_id = null`. It also delivered 18,616 Collector
Crypt spin pulls with a nonblank pack ID and `card_id = null`. Both sets retain
a stable pull record ID. There is no authoritative value for either missing
relationship, so PackScout must not infer or fabricate one.

## Sole current contract

DataForrest has one exact production tuple:

- source adapter `dataforrest-events-adapter-v1`;
- normalized observation `packscout.provider-observation.v1`; and
- mapper revision `1` for the provider's registered mapper.

The V1 raw pull shape requires the `pack_id` and `card_id` keys, permits each
value to be nullable, and rejects a pull when both values are null. The
normalized observation requires at least one relationship and permits at most
one pack and at most one card relationship. Relationship order is canonical:
pack before card when both exist.

A one-sided pull is canonical with only the edge DataForrest supplied. A
card-only pull cannot contribute to pack-scoped Heat, EV, or pack attribution.
A pack-only pull retains its pack relationship but has no card attribution.
Downstream behavior uses only present edges until the provider supplies an
authoritative missing identity.

Unknown or historical tuples fail closed. There is no fallback, dual read,
dual write, source-replacement path, or provider-name branch in generic
orchestration.

## Clean-slate reset and reimport

This early-development cutover intentionally does not reinterpret retained
rows. Stop the local admin and worker runtimes, then run the guarded
`npm run db:reset:local` command against the loopback development database.
The command drops and reapplies every migration and runs the canonical local
seed. It removes organizations, operators, sessions, audits, source
configuration, import evidence, canonical records, and promotion state; the
seed restores only the minimum local organization and stable provider roots.

Immediately follow the
[local reset and first-administrator bootstrap](../local-development-first-admin-bootstrap.md)
and run `npm run db:bootstrap-first-admin:local`; its password comes from the
hidden prompt or approved standard input, never argv or an environment
variable. Then recreate the encrypted DataForrest connection, create and test
each source under the sole current tuple, and reimport from Feed start.
Cursor reset, adapter upgrade, source replacement, quarantine retry, and
selective table deletion are not substitutes for the clean reset because
previously rejected records have no normalized observation or semantic
identity. Reconcile provider outcomes and canonical catalog, pull, and
market-event counts at provider head.

The dedicated Task 010 database follows its stricter empty-target procedure in
the Task 010 runbook. Do not run the normal seeded reset against that target.
