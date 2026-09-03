# Local development reset and first-administrator bootstrap

Use this workflow only for the normal, disposable PostgreSQL development
database. It is not the guarded Task010 target and is never a production or
preproduction provisioning path.

The reset removes every relational row, including operators, memberships,
sessions, audits, connection configuration, source revisions, import history,
canonical data, and quarantines. Recovery is a full reconfiguration and
reimport; there is no in-place compatibility migration in early development.

## 1. Stop local runtimes and bind the target

Stop the admin and every worker before resetting. Export the ignored local
environment values in the shell that will run the commands:

```bash
export NODE_ENV=development
export PACKSCOUT_DATABASE_URL='postgresql://packscout@127.0.0.1:5432/packscout_dev'
export PACKSCOUT_BOOTSTRAP_ADMIN_EMAIL='admin@example.test'
export PACKSCOUT_BOOTSTRAP_ADMIN_DISPLAY_NAME='Primary Admin'
unset PACKSCOUT_BOOTSTRAP_ADMIN_PASSWORD
```

Use the real loopback development URL and approved administrator address; the
example values are placeholders. The first-admin command accepts no arguments
and deliberately refuses a password environment variable. Do not put the
password in a command, shell history, tracked file, screenshot, or log.

## 2. Reset, then create exactly the first administrator

```bash
npm run db:reset:local
npm run db:bootstrap-first-admin:local
```

On an interactive terminal the second command prompts without echo. For an
approved password-manager integration, deliver one password line on standard
input; never interpolate it into the command itself. The same managed-password
policy and Argon2id settings used by the admin are applied.

The bootstrap independently verifies all of these conditions before writing:

- `NODE_ENV` is exactly `development`;
- the configured URL and the connected PostgreSQL server are loopback, name
  the same non-system database, and contain no ambiguous URL options;
- the database has the exact one organization and six provider roots produced
  by the checked-in normal development seed;
- every other application model is empty, including operators, memberships,
  sessions, audits, source configuration, imports, and canonical data.

One serialized transaction creates an active administrator, its `admin`
membership, and a secret-free `operator.provision` audit receipt. If any
operator already exists, any material history remains, the seed differs, or a
concurrent attempt wins, the command refuses without adding another account.

## 3. Restore runtime secrets and source configuration

Keep the admin session HMAC secret, actor-pseudonym key, connection-encryption
key, and provider credential key in the ignored local environment or approved
secret store. The bootstrap password is not one of those runtime variables.
Start one admin and exactly one intended worker, then sign in as the new
administrator.

Open **Source Configuration** and follow the
[ingestion pipeline operator guide](ingestion-pipelines/README.md#configure-a-new-pipeline):

1. create and test the shared DataForrest connection with the authorized
   bearer;
2. activate that exact tested connection revision;
3. create, test, and activate the current v1 source revision for Courtyard,
   Collector Crypt, Phygitals, and ClutchPacks;
4. resume the four lanes from Feed start and monitor the full reimport.

Never restore old source rows, encrypted credential blobs, cursors, or
canonical records into this clean schema. Re-enter the connection secret
through the admin so it is encrypted by the current local key.
