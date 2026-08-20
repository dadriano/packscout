# Task: Inspect the Database Safely

**ID:** admin-tools/014
**Depends on:** admin-tools/010
**Blocks:** admin-tools/015
**Estimated scope:** medium
**Status:** todo

## Objective

The operations panel tells an operator the truth about the local database at a glance — what it is, whether it's reachable, how big it is, what's in it, and whether migrations are current — and offers a supervised row browser for looking inside, all without ever exposing credentials or accepting caller-supplied SQL.

## Context

This ports the reference panel's database surface. Its safety posture is the point and must survive the port intact:

- connection credentials are resolved server-side from the environment/config the applications already use; they never appear in responses, client state, logs, or child-process argument lists;
- the database's locality is classified fail-closed: only provably loopback/local hosts count as local, anything else (including unparseable configuration) is treated as non-local, and every risky capability is gated on that classification server-side;
- there is no SQL runner, no schema browser beyond summary statistics, and no path that executes caller-supplied commands or queries — a permanent invariant;
- row-level inspection is delegated to the ORM's own studio tool, run as a supervised child process, embedded in the panel, and clearly labeled as a full read/write editor without the panel's guardrails.

The target is the pipeline's relational store: the PostgreSQL database whose schema and migrations are owned by the ORM in the workspace's database package. It is explicitly not the product's hosted document backend (which the repository's top-level guide calls "the backend") — that system has its own tooling and is out of scope for this panel. Status must be honest across the unhappy paths: no configuration found, configured but unreachable, reachable but unqueryable.

## Requirements

- A database status view showing: the connection identity (host, port, database name — never credentials), the fail-closed locality classification, reachability, database size, and the largest tables with approximate row counts, refreshable on demand and updating live while the surface is open.
- Migration state derived by comparing applied history in the database against the migrations present in the repository: counts of applied, a list of pending, and failed ones surfaced — aggregated by migration name so a rolled-back-then-reapplied migration reads as applied; a fresh database with no migration history reads as behind, not unknown.
- The three unhappy states (unconfigured, unreachable, unqueryable) are visually distinct and truthfully worded.
- An embedded row browser: the panel starts the ORM's studio as a supervised child (readiness detected, bounded startup timeout, crash or exit reflected live in the UI, always terminated when the panel shuts down), embeds it in the panel with an open-in-new-tab escape hatch, and labels it plainly as a full read/write editor with none of the panel's guardrails.
- The row-browser child is itself a second HTTP listener and must be reachable only from loopback: the panel binds or constrains it to a loopback address, verifies that before embedding, and refuses to embed (with an explanation) if it cannot guarantee the loopback bind — otherwise the child would silently undo the panel's structural security model.
- Launching the row browser is refused server-side when the database is not provably local, regardless of any client-side state; the refusal explains why.
- Starting/stopping the row browser is a guarded mutation (admin-tools/010's origin guard) and is audited.
- No endpoint accepts caller-supplied SQL, commands, or file paths; summary statistics come from fixed, parameterless server-side queries.

## User-Facing Behavior

An operator opens Data and sees the status card: which database the apps point at, that it's local and reachable, its size, its biggest tables, and that migrations are current — or exactly which of those statements fails and why. One click starts the row browser; a startup spinner resolves into the embedded editor with a visible warning banner, and stopping the panel takes it down. If someone points the environment at a shared/remote database, the row browser (and everything dangerous) is replaced by an explanation that the target is not local.

## Interface Contract

- Status is exposed as a snapshot read plus a live stream (admin-tools/010's SSE conventions) with the logical shape: identity (host/port/name), locality, reachability, size, table summaries, migration state, and error wording for the unhappy states.
- The locality classification and current-target identity are server-side facts that admin-tools/015 re-checks at execution time; this task must expose them for reuse rather than burying them in the view.

## Acceptance Criteria

- [ ] The status view reports identity, locality, reachability, size, top tables, and migration state accurately, with the three unhappy states distinct and honest.
- [ ] Credentials never appear in any response, client state, log, or child-process argument list.
- [ ] A non-local or unparseable database target classifies as non-local and the row browser refuses to launch server-side with a clear explanation.
- [ ] The supervised row browser starts, embeds, survives-or-reports crashes truthfully, and is terminated on panel shutdown; its launch/stop actions are origin-guarded and audited.
- [ ] The row-browser child listens only on a loopback address, and the panel refuses to embed it when that cannot be verified.
- [ ] Migration aggregation reads rolled-back-then-reapplied migrations as applied, and a fresh database as behind.

## Verification

Pure-logic tests prove the locality classifier's fail-closed behavior (loopback variants local; hostnames, unparseable URLs, and remote IPs non-local) and the migration-state aggregation cases; supervision tests prove readiness detection, startup timeout, crash reflection, and shutdown teardown. The panel test suite and workspace typecheck exit 0.
