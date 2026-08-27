# ClutchPacks V3 public catalog candidate

Status: guarded local candidate generation for the first isolated Convex canary

Use this workflow only after the ClutchPacks V3 replay in the separate local
PostgreSQL target has reached provider head, its source has been paused, and its
source supervisor has stopped. It does not use Neon and does not read or write
the active multi-provider V1 database.

## What the generator proves

Both dry-run and execute open the exact query-free loopback database
`packscout_clutchpacks_v3_canary` in a read-only repeatable-read transaction.
Generation fails closed unless all of the following remain true:

- the target has one ClutchPacks provider and one paused adapter-v3 source;
- the normalized V1 contract, mapper, namespace, cursor codec, and successful
  provider-head run all have their canonical exact values;
- no import run or source supervisor is live;
- every persisted delivery uses adapter V3 with the normalized V1 contract;
- quarantine, warning, and critical diagnostic counts are zero;
- every current pull has one exact native relationship confirmation set, every
  physical member is resolved, and the backfill proof is complete;
- provider and global settlement equal source head with no pending obligation;
- every current pack and catalog asset is mapped, and every associated asset
  has a nonblank public name.

The candidate deliberately does not infer card metadata. Year, brand, series,
card number, grade, and grader remain unset. It does apply the reviewed,
fail-closed ClutchPacks taxonomy for the exact observed values `Sports`, `TCG`,
`Baseball`, `Basketball`, `Football`, `Soccer`, `Multisport`, `Marvel`,
`One Piece`, and `Pokemon`; an unknown non-null source category stops
generation. Public IDs are
UUIDv5 values derived from an explicitly approved namespace and stable source
keys. HTTPS origins are derived from current canonical content and revalidated
by the approved public catalog schema. Each UUID pack identity also receives
the reviewed `https://clutchpacks.io/checkout/<pack-id>/` listing URL, governed
by the vendor's exact `clutchpacks.io` listing-host allowlist.

## Protected local environment

Set the exact local target binding and all policy decisions explicitly:

```text
NODE_ENV=development
PACKSCOUT_RUNTIME_ENVIRONMENT=local
PACKSCOUT_DATABASE_URL=postgresql://<local-user>@127.0.0.1:5432/packscout_clutchpacks_v3_canary
PACKSCOUT_CLUTCHPACKS_V3_CANARY_ORGANIZATION_ID=<target UUID>
PACKSCOUT_CLUTCHPACKS_V3_TARGET_ACK=I_UNDERSTAND_THE_TARGET_MUST_BE_A_FRESH_LOCAL_DATABASE
PACKSCOUT_CLUTCHPACKS_CATALOG_NAMESPACE_UUID=<approved UUIDv5 namespace>
PACKSCOUT_CLUTCHPACKS_CATALOG_CONFIGURATION_KEY=<approved key>
PACKSCOUT_CLUTCHPACKS_CATALOG_REVISION=<positive integer>
PACKSCOUT_CLUTCHPACKS_CATALOG_APPROVED_AT=<canonical UTC timestamp>
PACKSCOUT_CLUTCHPACKS_CATALOG_STALE_AFTER_SECONDS=<60..31536000>
PACKSCOUT_CLUTCHPACKS_CATALOG_CONFIDENCE_POLICY_VERSION=<approved version>
PACKSCOUT_CLUTCHPACKS_CATALOG_COMPLETE_SCORE_BPS=<0..10000>
PACKSCOUT_CLUTCHPACKS_CATALOG_PARTIAL_SCORE_BPS=<0..10000>
PACKSCOUT_CLUTCHPACKS_CATALOG_UNKNOWN_SCORE_BPS=<0..10000>
PACKSCOUT_CLUTCHPACKS_CATALOG_LIMITATION_PENALTY_BPS=<0..10000>
PACKSCOUT_CLUTCHPACKS_CATALOG_VENDOR_DISPLAY_NAME=ClutchPacks
PACKSCOUT_CLUTCHPACKS_CATALOG_FORMAT=repack
```

The database URL must not contain a password, query string, or non-loopback
host. Keep the output outside the repository in a private local runtime
directory.

## Generate and approve

1. Run the read-only plan with the final absolute output path:

   ```bash
   npm run generate:catalog-candidate:clutchpacks:local -- \
     --output /absolute/private/path/clutchpacks-v3-catalog.json
   ```

   Review the target, head run, counts, serialized size, configuration hash,
   and candidate digest. The command emits no canonical names or external IDs.

2. Copy the exact `requiredConfirmation` from that same plan and create the
   candidate. Execute re-runs every database proof and refuses an existing
   output path.

   ```bash
   npm run generate:catalog-candidate:clutchpacks:local -- \
     --execute \
     --output /absolute/private/path/clutchpacks-v3-catalog.json \
     --confirmation "WRITE CLUTCHPACKS V3 CATALOG LOCAL <16hex>"
   ```

   Verify the resulting file is a regular file with mode `0600`.

3. Bind the isolated local target to the preproduction approval lane and run
   approval dry-run:

   ```bash
   PACKSCOUT_RUNTIME_ENVIRONMENT=preproduction \
   PACKSCOUT_PUBLIC_ORGANIZATION_ID=<target UUID> \
   PACKSCOUT_CATALOG_DEPLOYMENT_KEY=clutchpacks-canary-v1 \
   PACKSCOUT_DATABASE_URL=<same local target URL> \
   npm run approve:catalog-configuration:clutchpacks:preproduction -- \
     /absolute/private/path/clutchpacks-v3-catalog.json --dry-run
   ```

4. Review exact canonical/configured coverage and zero unnamed associated
   assets. Then repeat with `--execute` and the emitted digest-bound approval
   confirmation:

   ```bash
   npm run approve:catalog-configuration:clutchpacks:preproduction -- \
     /absolute/private/path/clutchpacks-v3-catalog.json \
     --execute \
     --confirmation "APPROVE CLUTCHPACKS PREPRODUCTION <16hex>"
   ```

Approval changes only the isolated local PostgreSQL target. Convex publication
is a separate, explicitly confirmed preproduction canary step. Neon remains out
of scope until the initial local import and canary are complete.
