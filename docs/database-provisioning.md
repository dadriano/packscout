# Distributed Database Provisioning

Status: canonical production and local database workflow

## Supported topology

PackScout supports PostgreSQL 16 or newer with two independently managed roles:

- one central control and shared-catalog database named exactly `packscout`; and
- one provider database named exactly `packscout_<provider_key>` for every
  registered provider, normally on an independently reachable PostgreSQL
  instance or cluster.

Each target starts empty. The central and provider Prisma schemas have separate
migration histories and generated clients. A provider migration is applied to
one provider database at a time; it is never broadcast implicitly to every
provider. Cross-database IDs are validated soft references, not foreign keys or
distributed transactions.

This is a clean pre-launch replacement. It does not upgrade, migrate, dual-run,
or import the previous single-database schema. Applying either migration history
to a non-empty incompatible database must fail visibly.

Do not reset, replace, or delete a database unless an operator has explicitly
confirmed its exact host, port, database name, environment, and disposable
status. The commands below never perform a reset.

## Validate and generate

From a clean checkout:

```bash
npm ci
npm run db:prisma:validate
npm run db:prisma:generate
```

These commands validate and generate the central and provider clients without
contacting a live target.

## Provision the central database

Create an empty database named `packscout`, then deploy only the central
migration history:

```bash
PACKSCOUT_CENTRAL_DATABASE_URL='<packscout-postgresql-url>' \
  npm run db:prisma:migrate:deploy:central
```

The baseline migration seeds the singleton `database_identity` row with role
`central`, schema version `distributed-central-v1`, and no provider identity.
Application startup verifies that row and `current_database()` before serving
traffic. It never migrates or repairs schema state.

## Provision one provider database

Choose a registered lowercase provider key, create an empty database named
`packscout_<provider_key>`, and deploy only the provider migration history:

```bash
PACKSCOUT_PROVIDER_DATABASE_URL='<packscout_provider-postgresql-url>' \
  npm run db:prisma:migrate:deploy:provider
```

The provider baseline deliberately leaves its singleton identity unbound. As a
separate, explicit provisioning step, invoke
`public.initialize_provider_database_identity(provider_id, provider_key)` once
using the provider UUID and exact registered key. The function verifies
`current_database() = 'packscout_' || provider_key`, rejects rebinding, and is
not called by normal application startup.

Repeat the migration deploy command against the same target. It must report
that no migrations remain. Repeat this sequence independently for every
provider; a failure for one target must not prevent another target from being
provisioned or started.

## Runtime configuration

- The current `apps/admin` runtime receives its central `packscout` connection
  as `PACKSCOUT_CONTROL_DATABASE_URL`. Worker and central Prisma utilities use
  `PACKSCOUT_CENTRAL_DATABASE_URL` for that same database authority.
- The generic provider runner and direct admin operations receive a validated
  provider ID. The server-owned gateway resolves the provider database locator
  and encrypted credential from central topology, then builds the connection
  only in memory. These runtime paths do not accept a provider URL from the
  environment.
- Provider schema-generation and migration commands use the explicitly scoped
  `PACKSCOUT_PROVIDER_DATABASE_URL`. The older Task 023 local entrypoint
  `run:clutchpacks-import-once:local` also still consumes that variable; it is
  retained for the completed standalone proof, not used by this parallel-run
  checkpoint. Use `run:provider-import-once:local` for the centrally routed
  runtime. Retire the older entrypoint after its proof coverage moves to the
  generic runner; do not use it as evidence that all historical tooling has
  already been ported.
- Provider pools are bounded independently. Central and provider transactions
  use explicit time limits.
- Central connection URLs and the provider-credential encryption key belong in
  the server environment or approved secret store; provider credentials remain
  encrypted centrally. Never commit, log, screenshot, or return secrets in an
  HTTP error.

The PostgreSQL instance or cluster supplies the environment boundary, so
database names do not receive development, preproduction, or production
suffixes.

## Migration controls awaiting a distributed port

Use only `db:prisma:migrate:deploy:central` or
`db:prisma:migrate:deploy:provider` with an explicitly selected target. The
unqualified aggregate deploy alias has been removed. It must not silently pick
a central database or fan out across providers.

The ops-panel's historical migration action is visible but unavailable: its
target confirmation and migration-history probe still describe the older
combined schema. Requests return a structured `409` before a process or run
marker starts. Re-enable it only after target resolution, schema selection,
history, and confirmation all identify the same central or single-provider
database. Existing seed/reset behavior is unchanged; this is not a claim that
the ops-panel has been ported.

The older Task010 migration entrypoint is also retired and refuses before
loading environment authority or opening a database. Neither retired path is a
fallback for distributed deployment.

## Readiness evidence

Before pointing a runtime at a target, require all of the following:

- both Prisma schemas validate and both generated clients build;
- the applicable migration deploy succeeds and a repeated deploy is a no-op;
- the singleton identity matches physical database name, role, schema version,
  and provider identity (for a provider target);
- schema contract, native-constraint, lifecycle, and isolation tests pass on
  PostgreSQL 16 or newer;
- `npm run verify:framework` passes without a bypass; and
- central, provider A, and provider B can start and close independently while an
  unreachable provider returns a sanitized, provider-scoped failure.

Migration deploy remains a release step. Runtime startup performs read-only
identity/readiness checks and never mutates schema state.

## Replacement approval

If a target already contains data or application objects, stop. A replacement
requires separate explicit approval naming the exact disposable target and a
recovery or recreation plan. Without that approval, create another empty target
and leave the existing database unchanged.
