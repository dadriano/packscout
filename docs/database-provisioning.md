# Database Provisioning

Status: canonical production and local database workflow

## Supported target

PackScout supports a newly created, empty PostgreSQL 16 or newer database. The
Prisma schema and checked-in Prisma migrations are the only application schema
and migration history.

This workflow does not preserve, upgrade, or import an existing database managed
by the removed persistence system. Applying migrations to a non-empty,
incompatible database must fail rather than silently changing or deleting its
objects.

Do not reset, replace, or delete a database unless the operator has explicitly
confirmed its exact host, port, database name, environment, and disposable
status. The commands below do not perform a reset.

## Provisioning sequence

From a clean checkout:

```bash
npm ci
npm run db:prisma:validate
npm run db:prisma:generate
PACKSCOUT_DATABASE_URL='<new-empty-postgresql-url>' npm run db:prisma:migrate:deploy
npm run check:prisma
npm run verify:framework
```

Run the migration deploy command a second time against the same new database.
It must report that there are no pending migrations. The Prisma schema parity
suite must still report the expected tables, columns, enums, keys, constraints,
indexes, and PostgreSQL-native invariants.

Keep the connection URL in the runtime environment or approved secret store. Do
not commit it, print it in verification output, or copy it into fixtures.

## Readiness evidence

Before pointing an application runtime at the database, require all of the
following:

- Prisma client generation and schema validation complete successfully.
- The initial migration deploy succeeds and a repeated deploy is a no-op.
- `npm run check:prisma` passes its clean-migration, parity, constraint, and
  lifecycle tests against PostgreSQL 16 or newer.
- `npm run verify:framework` passes without skipped critical regressions or new
  framework exceptions.
- Admin and worker smoke flows start against a clean migrated database and close
  their Prisma client cleanly.

After that evidence is recorded, supply `PACKSCOUT_DATABASE_URL` to the admin or
worker runtime and use the environment-specific start command. Migration deploy
remains a separate release step; application startup does not mutate the schema.

## Replacement approval

If a target already contains data or application objects, stop. Decide whether
it may be discarded outside this workflow. A replacement operation requires a
separate, explicit approval naming the exact disposable database target and a
recovery or recreation plan. Without that approval, create a different empty
database and leave the existing target unchanged.
