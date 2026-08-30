# Launch-provider review clusters

This local-only workflow manages five fixed PostgreSQL 16 clusters: the
existing control and ClutchPacks pair plus three additive launch-provider
clusters. It never connects to the normal development PostgreSQL instance and
has no drop, rebuild, or backup mode.

| Cluster | Fixed data directory suffix | Port | Database | Runtime login |
| --- | --- | ---: | --- | --- |
| control | `Library/Application Support/PackScout/postgres-review/control` under the macOS account home | 55431 | `packscout` | `packscout_control_app` |
| ClutchPacks | `Library/Application Support/PackScout/postgres-review/clutchpacks` under the macOS account home | 55432 | `packscout_clutchpacks` | `packscout_clutchpacks_app` |
| Courtyard | `Library/Application Support/PackScout/postgres-review/courtyard` under the macOS account home | 55433 | `packscout_courtyard` | `packscout_courtyard_app` |
| Collector Crypt | `Library/Application Support/PackScout/postgres-review/collector_crypt` under the macOS account home | 55434 | `packscout_collector_crypt` | `packscout_collector_crypt_app` |
| Phygitals | `Library/Application Support/PackScout/postgres-review/phygitals` under the macOS account home | 55435 | `packscout_phygitals` | `packscout_phygitals_app` |

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

## Add the remaining launch providers

The additive provider provisioner requires the already-provisioned control and
ClutchPacks clusters to be running and healthy. It inspects those two clusters
read-only. It never initializes, starts, stops, migrates, recreates, or registers
over them. Only the fixed Courtyard, Collector Crypt, and Phygitals targets are
created or resumed.

Inspect the three additive targets without credentials:

```sh
npm run db:inspect:additional-providers-review:local
```

Provisioning requires these process-only inputs:

- `PACKSCOUT_LOCAL_CONTROL_APP_PASSWORD`
- `PACKSCOUT_LOCAL_CLUTCHPACKS_APP_PASSWORD`
- `PACKSCOUT_LOCAL_COURTYARD_CLUSTER_ADMIN_PASSWORD`
- `PACKSCOUT_LOCAL_COURTYARD_APP_PASSWORD`
- `PACKSCOUT_LOCAL_COLLECTOR_CRYPT_CLUSTER_ADMIN_PASSWORD`
- `PACKSCOUT_LOCAL_COLLECTOR_CRYPT_APP_PASSWORD`
- `PACKSCOUT_LOCAL_PHYGITALS_CLUSTER_ADMIN_PASSWORD`
- `PACKSCOUT_LOCAL_PHYGITALS_APP_PASSWORD`
- `PACKSCOUT_LOCAL_BOOTSTRAP_ADMIN_EMAIL`
- `PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64`
- optional `PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION` (defaults to `1`)
- optional `PACKSCOUT_LOCAL_ORGANIZATION_SLUG` (defaults to
  `packscout-local-review`)

The eight PostgreSQL passwords must be distinct. The new provider application
credentials are used only to create and prove the local roles, then each
`{username,password}` pair is encrypted into the central
`provider_credential_versions` table and routed through its central
`provider_database_nodes` row. No provider DSN or password is written to an
environment file, output, audit record, provider database, or runtime
configuration. Courtyard receives a provider-scoped copy of the already-active
central ClutchPacks DataForrest credential. The provisioner decrypts that value
only in memory, immediately re-encrypts it with Courtyard's provider and
revision AAD, and drops the plaintext reference. It never requires, prints, or
writes a raw source token. The source clone is accepted only from the exact
active ClutchPacks distributed adapter, Events v1 endpoint,
`{"platform":"clutchpacks"}` configuration, no-expiration revision, and active
source credential.

Run the additive provisioner with:

```sh
npm run db:provision:additional-providers-review:local
```

Before any central registration, all three provider databases must be reachable,
role-isolated, correctly identified, idle, and empty of commands, runs, cursors,
promotion changes, and canonical rows. A fresh cluster remains marked
`initialized` while these proofs run; the provisioning-only proof path accepts
that exact owned state, while ordinary inspection and startup still require a
`provisioned` marker. All three then receive a public profile,
distributed DataForrest configuration, encrypted database credential, primary
node, truthful connection-test evidence, and audit registration. Courtyard's
activation test is written only after one authenticated, hardened, one-record
source request succeeds for the Courtyard platform. It is activated and marked
for the installed execution capability. Collector Crypt and Phygitals have no
source credential or execution capability. Each receives its successful
`database` connection test plus a separate `activation` attestation whose exact
summary says that only database reachability was checked, no source check was
performed, and execution capability is uninstalled. That truthful source-free
evidence permits both providers to become centrally `active` with their exact
active configuration, so the admin can route to their databases without
claiming that either provider can import.
The three central registrations, including Courtyard activation, are committed
in one serializable transaction after deterministic provider locks. A failure
for any provider rolls back all three; exact all-present state is resumable and
mixed presence is refused. Cluster markers advance to `provisioned` only after
the central batch commit succeeds.

On success, all three PostgreSQL clusters remain running so the admin can prove
their database reachability independently. Only Courtyard has an installed
execution capability or source credential, so Collector Crypt and Phygitals
remain empty and idle even though their databases are reachable. Emitted
lifecycle and isolation evidence contains a domain-separated data-directory
hash, never an absolute workstation path, DSN, or credential.

Each new cluster has independent `db:inspect:*:local`, `db:start:*:local`, and
`db:stop:*:local` package commands named for `packscout-courtyard`,
`packscout-collector-crypt`, or `packscout-phygitals`. A start or connected
inspection accepts the matching application password only as a process input;
normal admin and worker routing resolves the encrypted credential and fixed
node from the central control database.
