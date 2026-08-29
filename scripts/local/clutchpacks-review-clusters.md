# ClutchPacks review clusters

This local-only workflow creates two PostgreSQL 16 clusters. It never connects
to the normal development PostgreSQL instance and has no drop, rebuild, or
backup mode.

| Cluster | Fixed data directory suffix | Port | Database | Runtime login |
| --- | --- | ---: | --- | --- |
| control | `Library/Application Support/PackScout/postgres-review/control` under the macOS account home | 55431 | `packscout` | `packscout_control_app` |
| ClutchPacks | `Library/Application Support/PackScout/postgres-review/clutchpacks` under the macOS account home | 55432 | `packscout_clutchpacks` | `packscout_clutchpacks_app` |

The script resolves the account home itself and rejects path, port, database,
role, and provider-key overrides. Each cluster has a distinct system identifier,
bootstrap superuser, NOLOGIN schema owner, application login, data directory,
and TCP port. The application login can connect only to its cluster's PackScout
database; it cannot connect to `postgres` or either template database. Runtime
table and sequence grants are enumerated explicitly.

Provisioning is create-or-resume. A resume is accepted only for an exact marker,
system identifier, managed configuration, and known partial role/database
topology. Identity UUIDs are derived from the two system identifiers, provider
identity initialization is exact-idempotent, and a previously committed central
registration must match every expected row, admin credential, and encrypted
provider credential. Any unowned nonempty directory or unexpected topology is
refused without deleting it.

## Commands

Filesystem inspection does not need credentials:

```sh
npm run db:inspect:clutchpacks-review:local
```

Provisioning requires these environment-only inputs; do not place them on the
command line:

- `PACKSCOUT_LOCAL_CONTROL_CLUSTER_ADMIN_PASSWORD`
- `PACKSCOUT_LOCAL_CLUTCHPACKS_CLUSTER_ADMIN_PASSWORD`
- `PACKSCOUT_LOCAL_CONTROL_APP_PASSWORD`
- `PACKSCOUT_LOCAL_CLUTCHPACKS_APP_PASSWORD`
- `PACKSCOUT_LOCAL_BOOTSTRAP_ADMIN_EMAIL`
- `PACKSCOUT_LOCAL_BOOTSTRAP_ADMIN_DISPLAY_NAME`
- `PACKSCOUT_LOCAL_BOOTSTRAP_ADMIN_PASSWORD`
- `PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64`
- optional `PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION` (defaults to `1`)
- optional organization slug/name inputs listed in the plan module

All four PostgreSQL passwords must be distinct. Provision with:

```sh
npm run db:provision:clutchpacks-review:local
```

After provisioning, each cluster is managed independently with the package
scripts named `db:start:*:local`, `db:stop:*:local`, and `db:inspect:*:local` for
`packscout-control` or `packscout-clutchpacks`. Start and connected inspection
use the corresponding application password from the environment. Stop needs no
credential.

The application connection-string shapes are:

```text
postgresql://packscout_control_app:<secret>@127.0.0.1:55431/packscout
postgresql://packscout_clutchpacks_app:<secret>@127.0.0.1:55432/packscout_clutchpacks
```

The provisioner emits only sanitized proofs and never prints a connection string
or credential.
