# PostgreSQL-to-Convex Promotion Runbook

Status: production operator contract

This runbook governs the one approved PackScout organization and Convex
deployment pair. PostgreSQL remains canonical. Convex receives only bounded,
public release documents and aggregate Heat frames after settlement. No public
request, provider payload, or Convex mutation may select an organization.

## Safety model

- Canonical writes and their causal public-change sequence commit together in
  PostgreSQL.
- A watermark advances only through contiguous causes whose derivations reached
  either success or a valid business-unavailable outcome. A technical failure
  blocks settlement.
- Provider publication is deterministic and immutable. Independent
  platform-bound lanes persist exact request bytes before sending and reconcile
  ambiguous sends by operation status. Provider completion never changes public
  state; only the serialized manifest compare-and-swap changes the active
  pointer after authoritative composition proves the full count/hash graph.
- A failed provider release or manifest publication never replaces the prior
  complete active manifest. Unchanged provider content reuses its complete
  provider release, and an unchanged manifest reference set advances
  observation freshness without minting a new manifest.
- Heat is a separate minute-boundary lane. Catalog activation never waits for
  Heat, and Heat must match the active manifest fingerprint and exact provider
  reference-set hash or fail closed.
- Durable alerts contain only a lane, bounded condition/code/count/duration,
  public watermark strings, and a PostgreSQL attempt UUID. The server derives a
  domain-separated SHA-256 deployment-scope digest for dedupe and recovery keys;
  alert reads match organization, deployment digest, and lane exactly. The raw
  deployment key never enters notifications, logs, or portable evidence, and
  tenant binding stays in protected PostgreSQL columns.

## Production configuration contract

Configure secrets through the deployment secret manager. Never print, paste
into evidence, or commit their values.

| Setting | Contract |
|---|---|
| `NODE_ENV` | Must be `production` for the live worker. |
| `PACKSCOUT_DATABASE_URL` | Required PostgreSQL URL. Startup also requires the exact latest migration checksum and table count. |
| `PACKSCOUT_PUBLIC_ORGANIZATION_ID` | Required UUID for the single approved public organization. It is resolved at process startup and never accepted from a request. |
| `PACKSCOUT_CATALOG_DEPLOYMENT_KEY` | Required server-side deployment key matching `^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$`. The same value scopes all provider lanes and the singleton manifest lane in PostgreSQL. |
| `PACKSCOUT_CONVEX_PUBLICATION_BASE_URL` | Required HTTPS origin only: no credentials, path, query, or fragment. |
| `PACKSCOUT_CONVEX_PUBLICATION_KEY_ID` | Required Heat-only versioned publication key. Provider and manifest promotion must not fall back to it. |
| `PACKSCOUT_CONVEX_PUBLICATION_SECRET_BASE64` | Required Heat-only canonical-base64 secret, decoding to 32 through 256 bytes. It is not provider or manifest authority. |
| `PACKSCOUT_CATALOG_PROVIDER_CREDENTIALS` | Required canonical JSON object mapping every configured `platformKey` to exact `{keyId,secretBase64}` own properties, at most eight entries. Keys are C-sorted, key IDs are unique, every secret decodes to 32 through 256 bytes, and decoded signing bytes are unique across all publication roles. Startup requires exact parity with the atomic configured-platform snapshot, including disabled lanes that may need reconciliation. Values are never logged. |
| `PACKSCOUT_CATALOG_MANIFEST_PUBLISH_KEY_ID` / `PACKSCOUT_CATALOG_MANIFEST_PUBLISH_SECRET_BASE64` | Required manifest publish/status credential. Its key ID and decoded secret bytes must be disjoint from every provider, clear, rollback, retain, and Heat credential. |
| `PACKSCOUT_CATALOG_MANIFEST_CLEAR_KEY_ID` / `PACKSCOUT_CATALOG_MANIFEST_CLEAR_SECRET_BASE64` | Required least-privilege clear credential. Its key ID and decoded secret bytes must be disjoint from every provider, publish, rollback, retain, and Heat credential so another leaked role cannot clear the catalog. |
| `PACKSCOUT_CATALOG_RETENTION_KEY_ID` / `PACKSCOUT_CATALOG_RETENTION_SECRET_BASE64` | Required least-privilege retain credential. Its key ID and decoded secret bytes must be distinct from provider, publish, clear, rollback, and Heat roles. Grant only `retain` in `PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES`. |
| `PACKSCOUT_CATALOG_RETENTION_INTERVAL_MS` | Optional completed-barrier cadence; default `3600000`, allowed `60000` through `86400000`. |
| `PACKSCOUT_CATALOG_RETENTION_CONTINUATION_INTERVAL_MS` | Optional active-barrier continuation/retry cadence; default `1000`, allowed `100` through `60000` and no greater than the completed-barrier cadence. |
| `PACKSCOUT_CATALOG_RETENTION_MAXIMUM_DOCUMENTS` | Optional Convex artifact-document bound per mutation; default `90`, allowed `9` through `90`. The protocol separately caps total deletion at 100 including journal rows. |
| `PACKSCOUT_CATALOG_RETENTION_MAXIMUM_POSTGRES_ROWS` | Optional PostgreSQL cleanup chunk; default `100`, allowed `10` through `100`. |
| `PACKSCOUT_CATALOG_RETENTION_MAXIMUM_STEPS_PER_CYCLE` | Optional coordinator work cap; default `25`, allowed `1` through `100`. Hitting the cap preserves the active barrier and continues at the continuation cadence. |
| `PACKSCOUT_CATALOG_PROMOTION_POLL_MS` | Optional; default `5000`, allowed `100` through `5000`. Provider/manifest eligibility and trigger facts are polled at least every five seconds. |
| `PACKSCOUT_CONVEX_PUBLICATION_TIMEOUT_MS` | Optional; default `10000`, allowed `100` through `30000`. Shared by provider, manifest, retention, and Heat publication. |
| `PACKSCOUT_HEAT_RETENTION_BATCH_SIZE` | Optional; default `500`, allowed `1` through `1000`. |
| `PACKSCOUT_HEAT_RETENTION_MAX_BATCHES_PER_CYCLE` | Optional; default `4`, allowed `1` through `20`. |
| `PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS` | Required in Convex. A strict JSON object mapping each versioned key ID to the same canonical-base64 secret configured on its publisher. The UTF-8 value must be at most 8 KiB, matching Convex's per-environment-value deployment limit. Decoded secret bytes must be pairwise unique across every configured entry, including unbound, rotation, or orphan IDs, because the key ID is not signed. Invalid key IDs, malformed JSON, arrays, an oversized value, noncanonical base64, decoded values outside 32 through 256 bytes, or any duplicate decoded secret make all provider, manifest, retention, Heat, and `data_release_v3` HTTP routes fail closed before nonce writes. A 64-provider roster with one distinct 32-byte provider key each plus all 24 ancillary slots is 6,029 bytes; measure the canonical value before adding overlapping rotations. |
| `PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS` | Required in Convex only when `data_release_v3` publication is enabled; leave it absent to keep the V3 write surface inert. Canonical JSON contains one through four C-sorted, unique V3-only publication key IDs for bounded overlap rotation. Every ID must resolve in `PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS` and must be absent from Heat, provider, and manifest authorities. Missing while V3 publication is attempted, malformed, noncanonical, duplicate, unsorted, unknown, or cross-role entries make V3 authentication fail closed; an invalid configured authority graph makes every authenticated publication route fail closed before nonce or state writes. |
| `PACKSCOUT_PUBLIC_CURSOR_HMAC_KEY` | Required in Convex wherever public `data_release_v3` pagination is enabled. Dedicated server-only HMAC key for opaque cursors; never expose it to the browser or publisher. It prevents callers from changing offsets, query bindings, release identity, or the server-pinned confidence clock. Rotate with a reviewed bounded pagination cutover because existing cursors intentionally fail closed after replacement. |
| `PACKSCOUT_HEAT_PUBLICATION_KEY_IDS` | Required in Convex. Canonical JSON contains one through four sorted, unique Heat-only publication key IDs for bounded overlap rotation. Every ID must resolve in `PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS` and must be absent from V3, provider, and manifest authority maps; missing, malformed, noncanonical, duplicate, unsorted, unknown, or cross-role entries make every Heat route fail closed before nonce or state writes. |
| `PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS` | Required in Convex for provider-release publication. A strict JSON object maps each provider publisher key ID to exactly one canonical `platformKey`, with at most 64 platforms and two current/previous key IDs per platform. The authenticated key ID must match the request platform; the map is server-side authority, contains no secrets, and is never returned. V3 and Heat key IDs must not appear in this map. |
| `PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES` | Required in Convex for manifest and retention operations. Canonical JSON maps at most 16 configured publication key IDs to a sorted unique nonempty subset of `clear`, `publish`, `retain`, and `rollback`. Activation, status, refresh, and block require `publish`; catalog retention requires `retain`; rollback and clear are separate capabilities. V3, provider, and Heat key IDs must not appear in this map. Unknown keys, malformed or noncanonical JSON, and unsorted/duplicate roles fail closed. Rotate by temporarily granting the same least-privilege role set to old and new configured key IDs, then remove the old entry after in-flight reconciliation. The map is never returned or logged. |

The V3 publisher's protected
`PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_ID` and
`PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_SECRET_BASE64` must match exactly one
entry authorized by the two Convex settings above. Deploy the V3 code while
`PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS` is absent, merge the new unique
secret into `PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS`, and only then set the
canonical V3 key-ID list. An extra unbound publication key remains inert; a V3
binding to an absent key invalidates the authority graph. Retire in the reverse
order: stop using the key and prove all signed requests have settled, remove the
V3 authority binding, and remove its secret entry last. Never replace the
entire secret map with a stale saved copy or expose its value through command
output.

The Heat scheduler runs at exact UTC minute boundaries and intentionally has no
poll-interval setting. Catalog activation alerting is fixed at 60,000 ms after
the settled watermark timestamp; it cannot be weakened with an environment
override.

Publication bounds are contract constants rather than environment settings:
100 records and 48 KiB per catalog batch, 128 KiB per ordinary authenticated
publication body, 256 KiB per complete catalog-retention proof request, and
4,096 batches per provider release. A healthy provider cycle may process the
full 4,098-operation start/batches/finalize protocol bound so representative
volume does not wait across many five-second polls. Claims lease for 30 seconds
and default to eight retries with a 500 ms through 30 second bounded backoff.
Each provider lane and the serialized manifest lane own an independent bounded
poll loop, so a slow provider request cannot delay manifest re-evaluation after
another provider completes.
Changing these limits is a reviewed contract/code change, not an operator
override.

The combined provider worker also validates its provider credential map,
manifest, retain, and Heat role credentials (including pairwise decoded-secret
uniqueness, because a key ID alone is not part of the request signature),
pseudonymization, scheduling, retention, and database-pool settings before
starting either promotion lane. A stable `*_INVALID` startup code is safe to
record; the rejected value and exception text are not.

## Named non-default Convex deployment

`npx convex deploy` does not use `CONVEX_DEPLOYMENT` as its exact target. When
that variable identifies any development or named deployment, `deploy` still
selects the project's default production deployment. Likewise,
`npx convex deployment select <name>` affects other Convex commands but
explicitly does not retarget `deploy`. Never use either mechanism to install
code on a named non-default deployment.

Use a short-lived deploy key created for the exact deployment, save it only in
a mode-`0600` file under a new mode-`0700` temporary directory, and pass that
file through `--env-file`. `--save-env` keeps the key out of stdout and the
custom path prevents `.env.local` from being created or changed. Disable shell
tracing for the whole operation. The current ClutchPacks canary is deliberately
pinned to `shiny-newt-310`; changing that name or URL requires a new protected
target approval.

Run this from the reviewed worktree. It verifies the full repository before
minting the token, performs a write-free exact-target dry run, installs code,
attests the expected V3 public functions on the named target, revokes the token,
and removes only its bounded temporary artifacts:

```bash
(
  set -euo pipefail
  set +x
  umask 077

  npm run verify:framework

  convex_cli=./node_modules/.bin/convex
  convex_target=shiny-newt-310
  convex_url=https://shiny-newt-310.convex.cloud
  convex_token_name="packscout-shiny-newt-310-v3-$(openssl rand -hex 8)"
  convex_token_dir="$(mktemp -d -t packscout-shiny-newt-310.XXXXXX)"
  convex_token_file="$convex_token_dir/deploy.env"
  convex_token_cleanup_needed=1
  env_local_before="$({
    if [ -f .env.local ]; then
      shasum -a 256 .env.local
    else
      printf '%s\n' absent
    fi
  })"

  convex_named() {
    env \
      CONVEX_DEPLOY_KEY= \
      CONVEX_DEPLOYMENT_TOKEN= \
      CONVEX_DEPLOYMENT= \
      CONVEX_SELF_HOSTED_URL= \
      CONVEX_SELF_HOSTED_ADMIN_KEY= \
      "$convex_cli" "$@"
  }

  cleanup_named_convex_token() {
    if [ "$convex_token_cleanup_needed" -eq 1 ]; then
      convex_token_cleanup_needed=0
      convex_named deployment token delete \
        "$convex_token_name" \
        --deployment "$convex_target" >/dev/null 2>&1 || true
    fi
    if [ -f "$convex_token_file" ]; then
      rm -f -- "$convex_token_file"
    fi
    if [ -d "$convex_token_dir" ]; then
      rmdir "$convex_token_dir"
    fi
  }
  trap cleanup_named_convex_token EXIT

  convex_named deployment token create \
    "$convex_token_name" \
    --deployment "$convex_target" \
    --save-env "$convex_token_file"
  chmod 600 "$convex_token_file"

  convex_dry_run="$("$convex_cli" deploy \
    --env-file "$convex_token_file" \
    --dry-run \
    --typecheck enable \
    --codegen disable 2>&1)"
  printf '%s\n' "$convex_dry_run"
  case "$convex_dry_run" in
    *https://shiny-newt-310.convex.cloud*) ;;
    *) exit 1 ;;
  esac
  case "$convex_dry_run" in
    *kindhearted-ermine-54*|*"Do you want to push"*) exit 1 ;;
    *) ;;
  esac

  "$convex_cli" deploy \
    --env-file "$convex_token_file" \
    --typecheck enable \
    --codegen disable \
    --message "Install data_release_v3 for the ClutchPacks canary"

  convex_named function-spec --deployment "$convex_target" |
    jq -e --arg expectedUrl "$convex_url" '
      .url == $expectedUrl and
      ([
        "publicRepacksV3.js:getPublicShellStatusV3",
        "publicRepacksV3.js:getDashboardBundleV3",
        "publicRepacksV3.js:listPublicRepacksV3",
        "publicRepacksV3.js:getPublicRepackV3",
        "publicRepacksV3.js:searchPublicCollectiblesV3",
        "publicRepacksV3.js:findRepacksByDesiredCollectibleV3",
        "dataReleaseV3ProviderObservation.js:refresh"
      ] as $required |
       [.functions[].identifier] as $actual |
       ($required - $actual | length) == 0)
    ' >/dev/null

  env_local_after="$({
    if [ -f .env.local ]; then
      shasum -a 256 .env.local
    else
      printf '%s\n' absent
    fi
  })"
  [ "$env_local_before" = "$env_local_after" ]

  convex_named deployment token delete \
    "$convex_token_name" \
    --deployment "$convex_target"
  convex_token_cleanup_needed=0
  cleanup_named_convex_token
  trap - EXIT
)
```

The deployment key is a secret even though it is short lived. Do not omit
`--save-env`, inspect the token file, enable shell tracing, copy command output
into evidence, or retain the temporary directory. If the shell is killed before
the trap runs, revoke the uniquely named token against `shiny-newt-310` before
continuing. `--codegen disable` also prevents the operator step from changing
`convex/_generated`; generate and review any required type changes before this
procedure instead.

### Local ClutchPacks `data_release_v3` promotion

This initial-import workflow reads only the exact loopback PostgreSQL database
`packscout_clutchpacks_v3_canary` and targets only `shiny-newt-310`. Neon and
the live multi-provider database are outside its authority. Complete the local
catalog-candidate approval and install the reviewed Convex V3 functions before
requesting a stage.

Set these protected values without shell tracing:

```text
NODE_ENV=development
PACKSCOUT_RUNTIME_ENVIRONMENT=local
PACKSCOUT_DATABASE_URL=postgresql://<local-user>@127.0.0.1:5432/packscout_clutchpacks_v3_canary
PACKSCOUT_PUBLIC_ORGANIZATION_ID=<canary organization UUID>
PACKSCOUT_CLUTCHPACKS_V3_READ_AT=<exact latest settled_at UTC timestamp>
PACKSCOUT_CONVEX_PUBLICATION_BASE_URL=https://shiny-newt-310.convex.site/
PACKSCOUT_CONVEX_URL=https://shiny-newt-310.convex.cloud/
PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_ID=<V3-only versioned key ID>
PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_SECRET_BASE64=<canonical base64 secret>
```

First run the write-free target plan. It opens only enough PostgreSQL state to
bind `current_database()`, the database OID, and the cluster system identifier
into the opaque stage confirmation:

```bash
npm run promote:data-release-v3:clutchpacks:local -- --dry-run
```

Review the exact database identity and `expectedRepackCount: 17`, then use the
returned confirmation to stage. Staging recomputes all 17 canonical EV rows,
requires known source time plus exact settled/head and lineage coherence,
rejects incomplete source lineage or any positive signed PackScout EV,
assembles the complete catalog, and finalizes an inactive Convex release. Age
alone is not a rejection: known calculable economics remain immutable release
evidence and the public read policy presents them as current or last-known with
a decaying confidence score. It never moves the public pointer.

```bash
PACKSCOUT_CLUTCHPACKS_V3_CONFIRMATION='<stage confirmation>' \
  npm run promote:data-release-v3:clutchpacks:local -- --stage
```

Do not bypass `CLUTCHPACKS_V3_POSITIVE_EV`. A positive signed PackScout EV still
fails closed; resolving one requires an explicit versioned methodology decision,
not clamping or a script override. True missing or unsupported essential inputs
retain their bounded unavailable reasons and do not become invented estimates.

After reviewing the staged fingerprint, accepted counts, unchanged active
pointer, expected predecessor, and the returned activation confirmation,
activate only that exact staged release:

```bash
PACKSCOUT_CLUTCHPACKS_V3_CONFIRMATION='<activation confirmation>' \
  npm run promote:data-release-v3:clutchpacks:local -- \
    --activate \
    --expected-release-fingerprint <64-hex staged fingerprint> \
    --expected-active-release <genesis-or-prior-public-release-UUID>
```

Activation repeats the database-identity, settlement, source-coherence,
fingerprint, predecessor, completeness, and non-positive-EV gates. It then
publishes a signed, release-bound provider observation from the actual local
source lifecycle and reads all 17 repacks plus bounded category, collectible,
chase, dashboard, and search paths through trusted-clock public V3 reads.
Provider health is informational and never erases catalog EV or gates Top
Opportunities. Source-evidence age is represented by EV confidence. A
failed post-activation proof rolls back to the guarded predecessor when one
exists; genesis verification failures require explicit recovery and return a
non-success status.

## Organization and deployment binding gate

Before every first activation or deployment move:

1. A release operator compares `PACKSCOUT_PUBLIC_ORGANIZATION_ID`,
   `PACKSCOUT_CATALOG_DEPLOYMENT_KEY`, and
   `PACKSCOUT_CONVEX_PUBLICATION_BASE_URL` with the protected deployment
   inventory. Record only the approval reference and pass/fail outcome.
2. Confirm the organization exists in PostgreSQL and that no second organization
   is approved for that Convex deployment.
3. Start the worker. When the durable bootstrap state is `unverified`, it
   queries the signed manifest active state and the signed completed head for
   every configured provider credential before any claim. PostgreSQL must prove
   every remote head from exact local operation/receipt evidence and prove
   either a pristine empty pointer, a cleared pointer with its exact terminal
   clear transition, or an exact active manifest definition, current
   transition, and ordered provider graph. A pristine pointer may legitimately
   coexist with a provider completed remotely and locally after a two-phase
   crash. Once that strict anchor is persisted, later restarts use its exact
   request/receipt chain and permit `sent` operations to status-reconcile before
   any newer remote state is adopted. This is required when Convex committed a
   finalize or activation but the local acknowledgement was lost.
4. Confirm the protected operational health view has no unresolved
   `promotion_*` alert. Do not copy the organization or deployment identifier
into the evidence bundle. A transient signed-probe, database-availability, or
concurrent-proof race is re-probed without allowing claims. A malformed,
receipt-mismatched, or otherwise unproven local graph refuses startup.

Never fix a binding failure by editing a lane row, changing a receipt digest, or
clearing Convex. Correct the deployment configuration and repeat bootstrap.

## Initial backfill and enablement

The combined production worker has two ordered, durable startup prerequisites.
It first materializes source-native V1 relationship confirmations through each
source revision's frozen delivery-occurrence watermark. It then repairs
normalized Heat from every confirmation-set item through a newly frozen public
causal watermark and assigns authoritative `catalog_order_sequence` values in
causal order. Repeated confirmation sets over one provider pull keep one stable
realized-pull identity; later corrections receive durable duplicate outcomes,
while their set-scoped catalog snapshots remain independently attributable.
Only after both prerequisites report `complete` may the source supervisor,
import, provider/manifest promotion, Heat publication, retention, or message
lanes start.

Both repairs use bounded transactions and durable cursors. Concurrent worker
instances serialize each step with database advisory locks; a non-runner waits
and rechecks the same durable state. `SIGINT` or `SIGTERM` leaves the last
committed cursor resumable and is a normal cooperative stop, not a failed
repair. A `pending`, `running`, `failed`, missing, count-inconsistent, or
watermark-inconsistent checkpoint fails reads, window closure, forward Heat
writes, provider readiness, and promotion closed. Do not replay import pages,
restart legacy ingestion, edit a cursor, or infer completion from the absence
of rows.

Checkpoint and normalized-evidence DML belongs only to the trusted combined
worker/migration database role. Operator, reporting, and incident-query roles
must remain read-only on these tables; ad hoc writes with application-owner
authority are not a supported repair mechanism.

Relationship repair pages advance over the materialized confirmation/effective
sequence tuple, and catalog ordering pages advance over the remaining unordered
partial index. Each phase takes one frozen target count and one terminal count;
it must not repeatedly rescan the full historical source set per page.

For the approved organization, retain the bounded checkpoint proof below. Do
not include the organization UUID in the evidence bundle:

```sql
select phase, count(*)::bigint as revision_count,
       sum(target_semantic_set_count)::bigint as target_set_count,
       sum(confirmed_semantic_set_count)::bigint as confirmed_set_count
from public.source_relationship_confirmation_backfills
where organization_id = $1::uuid
group by phase
order by phase;

select phase, target_public_change_sequence,
       processed_through_public_change_sequence,
       processed_through_confirmation_public_change_sequence,
       processed_through_confirmation_set_id,
       processed_through_relationship_id,
       target_relationship_source_count, relationship_source_count,
       target_catalog_observation_count, catalog_observation_count,
       failure_code
from public.normalized_heat_relationship_backfills
where organization_id = $1::uuid;

select count(*)::bigint as unordered_catalog_observation_count
from public.normalized_heat_observations
where organization_id = $1::uuid
  and observation_kind = 'catalog_snapshot'
  and catalog_order_sequence is null;
```

Every relationship-confirmation row must be `complete` with equal target and
confirmed counts. The Heat row must be `complete`, have equal relationship and
catalog target/processed counts, have no failure code, and the unordered count
must be zero. The frozen causal and delivery watermarks and these exact counts
are the restart proof; a newer ordinary forward write does not invalidate a
completed historical repair.

The first catalog is allowed only when all of these gates pass:

1. An approved, versioned public catalog configuration and governed public
   repack mappings exist at or before the target watermark.
2. Every enabled platform resolves to one exact active source instance and
   source-native revision.
3. Every exact active source revision has a successful import that reached
   provider head.
4. Every source-native V1 revision has complete, count-consistent relationship
   confirmation coverage, including exact V1 adoption of a physical edge first
   created by the retired legacy projector.
5. The normalized Heat relationship repair and causal catalog ordering are
   complete and count-consistent.
6. Every causal derivation through the target is settled. Business-unavailable
   outcomes are valid; pending, claimed, or technical-failure outcomes are not.
7. The deterministic full rebuild passes public projection, origin, reference,
   record-count, byte-count, and hash checks.
8. The authenticated bootstrap proves the complete remote provider-head graph
   plus a pristine, cleared, or exact PostgreSQL-owned active manifest state.

`INITIAL_BACKFILL_INCOMPLETE`, `INITIAL_PROVIDER_DELAYED`,
`PUBLIC_CONFIGURATION_UNAPPROVED`, and technical settlement alerts are blockers,
not retry bypasses. After the first complete activation, a delayed provider may
retain its last settled public values. The active manifest observation must then
report a nonzero `delayedProviderCount`; the provider release must not mix
unsettled rows into its content.

Removing a provider configuration is a separate, ordered operation from
disabling it. First settle the lifecycle disable while the provider remains in
the configured credential map. Next, wait for the authenticated manifest
activation (or last-provider clear) that removes the platform from the public
active selections, and reconcile every dispatched provider operation. Only
then approve configuration removal and deploy the exact smaller credential
map. PostgreSQL rejects removal while the platform is still public or has
dispatched recovery work, including a concurrent first dispatch. Never delete
the provider credential to force omission; the manifest pointer is the only
public cutover.

### ClutchPacks preproduction catalog-only canary

The sole approved exception to the organization-wide startup gate is the
preproduction ClutchPacks catalog canary. All shared workers must be stopped;
the approved configuration, enabled-platform set, and provider credential map
must each contain exactly `clutchpacks`; its current source-native V1 import
must have reached provider head; and the PostgreSQL organization, deployment
key, and Convex hostname must be the reviewed preproduction targets. First run
the read-only target-bound plan, then copy its exact opaque confirmation into
the protected execute environment:

```bash
npm run catalog:canary:clutchpacks:preproduction -- --dry-run
PACKSCOUT_CLUTCHPACKS_CANARY_CONFIRMATION='<plan confirmation>' \
  npm run catalog:canary:clutchpacks:preproduction -- --execute
```

The command requires `NODE_ENV=production`, `PACKSCOUT_DATABASE_URL`,
`PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64`, `PACKSCOUT_PUBLIC_ORGANIZATION_ID`, the
normal Promotion V2 URL/deployment/provider/manifest credentials,
`PACKSCOUT_RUNTIME_ENVIRONMENT=preproduction`, and
`PACKSCOUT_CUTOVER_WORKERS_STOPPED=YES`. The target must be pristine, cleared,
or exactly owned by the authenticated bootstrap proof. It repairs coverage
only for ClutchPacks, reports aggregate source-revision and semantic-set counts,
then proves durable provider completion before attempting manifest activation.
It never constructs Heat, retention, ingestion, source-supervisor, or combined
worker lanes; Heat must remain `NOT_PUBLISHED`. Remove this scoped entrypoint
after the ClutchPacks preproduction certification (and before live activation).
Normal production startup remains organization-wide and must complete both
relationship and normalized-Heat prerequisites.

## Manifest composition trust and read bounds

- The separately authorized PostgreSQL manifest composer is the authority for
  the repeatable-read settled eligibility snapshot and composition proof. Before
  it persists or signs an activation request, it must reject an omitted enabled
  platform, an included disabled platform, duplicate ownership, conflicting
  shared category or collectible bytes, unresolved cross-references, and
  aggregate count/hash drift. Task 011 owns those pre-dispatch tests.
- Convex intentionally does not mirror PostgreSQL eligibility state or rescan
  provider entity tables during activation. Its bounded transaction validates
  the signed manifest, at most eight exact complete provider-release and
  historical terminal proofs, selection policy, and expected active pointer
  before the one compare-and-swap commit. Public reads independently fail closed
  if stored composition has drifted.
- The sum of every referenced provider's physical category-copy count is capped
  at 4,096, even when the global deduplicated category union is smaller. This
  keeps exhaustive shared-category validation within Convex transaction limits.
- An untyped collectible search uses one release-filtered full-text query per
  selected provider. A typed search uses one such query per provider and each
  canonical selected type because the index cannot express the required OR
  filter without historical-result starvation. The six-value type vocabulary
  and eight-provider limit cap this reviewed deviation at 48 queries; Task 014
  owns launch p95 certification.

## Normal health and alert evidence

The protected PostgreSQL alert ledger is authoritative for operator alerts.
Console logs are diagnostic only.

Alert and recovery keys are isolated by the server-derived deployment digest
and lane. A recovery in one deployment must not resolve, suppress, or count an
alert for another deployment in the same organization.

| Condition | Durable kind | Required safe evidence | Recovery condition |
|---|---|---|---|
| Ready catalog or Heat target remains unconfirmed for at least one minute | `promotion_activation_delayed` | lane, target and confirmed watermarks, duration | Lane confirms through the target and has no technical settlement block. |
| A technical derivation exists beyond the contiguous settled watermark | `promotion_settlement_blocked` | lane, source-head and settled watermarks, count | Technical block is resolved and the lane confirms the resulting settled target. |
| Terminal transport, contract, assembly, or reconciliation failure | `promotion_failed` | lane, terminal/reconciliation condition, attempt UUID, target and confirmed watermarks, stable failure code | A later exact publication or unchanged refresh confirms the target with no block. |
| Any of the preceding conditions clears, including after process restart | `promotion_recovered` | lane, target and confirmed watermarks | Resolves every active alert sharing that lane recovery key. |

Repeated health polls do not create repeated in-process condition events. On
restart, the service checks the durable unresolved-alert count: a healthy lane
emits recovery only when PostgreSQL proves recovery is pending. No standalone
healthy-start event is written.

The lane evaluator cannot write a durable alert while its worker process is
down. Production launch therefore requires an independent deployment-supervisor
or external monitor that alerts on worker liveness and on a Heat confirmed frame
that is not advancing, early enough to respond before the 15-minute frame expiry.
The external monitor covers process-down failures; the durable lane alerts above
cover process-alive publication and reconciliation failures. Record both monitor
checks as production evidence. No application health endpoint is required by
this runbook.

Provider health logs may include the bounded public platform key; separate
settled, completed, and active checkpoints; completed and active lag; requested
and confirmed evaluation sequences; active attempt state/start/age; retry time;
activation/reconciliation times; failure code; and delayed-provider count.
Manifest health may include its requested/confirmed sequence, active generation,
age, retry/CAS result, and reconciliation state. Heat health may include its
frame, requested, and confirmed sequences; active attempt state/age; retry and
last activation/unchanged times; signal-set reuse; acknowledged operation count;
the public manifest release ID and provider-reference-set hash needed to prove
alignment; an alignment-current flag; frame calculation time, bounded age,
expiry time, and expired flag; failure code; and normalized-retention
batch/deletion/cap state. They must not include an organization, deployment
key, internal provider identity, raw observation, credential, signing material,
actor, tenant, run, or quarantine detail.

## Retry, reconciliation, restart, and shutdown

- Leave `sent` operations in the durable ledger after timeout, disconnect,
  malformed response, invalid response authentication, or shutdown. The next
  cycle asks authenticated operation status first and resends the exact stored
  bytes only when status proves the operation absent.
- Do not construct replacement JSON, skip an ordinal, lower a watermark, or
  manually acknowledge an operation. Operation ID, canonical body, request
  digest, receipt body, and receipt digest are immutable recovery evidence.
- A stale claim token cannot acknowledge, retry, or complete an attempt. Allow
  its lease to expire so another worker can reclaim it.
- On `SIGINT` or `SIGTERM`, the worker aborts every in-flight provider and
  manifest request, awaits all sibling cycles, and stops promotion and Heat
  before closing PostgreSQL. Supervisors should allow the
  normal graceful-stop window. A forced kill is recoverable because dispatch
  was recorded before the network send.
- After restart, require either the first strict bootstrap proof or an existing
  persisted bootstrap anchor, then status-first resolution of every ambiguous
  operation before declaring the lane recovered. Never infer the anchor from
  remote rows or a pointer alone.

If reconciliation fails terminally, keep the prior pointer active, preserve the
attempt and receipt evidence, and investigate the stable code. Never repair a
hash/count mismatch by mutating staged Convex documents.

## Key rotation

Signing rotation uses an overlap; it never changes an existing operation body.

1. Generate a new 32 through 256-byte secret and a new versioned key ID in the
   target secret manager. Select exactly one authority: `data_release_v3`, one
   provider platform, manifest publish, manifest clear, manifest rollback,
   catalog retention, or Heat. Never reuse a key ID or decoded secret bytes
   across authorities.
2. Add the new key ID and canonical-base64 value to the strict
   `PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS` JSON map while retaining the old
   entry. For a provider publisher, also add the new key ID with the same
   platform binding to `PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS`. For manifest
   publish, clear, rollback, or retention, add only the same least-privilege
   role to `PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES`. For Heat, add the key ID to
   `PACKSCOUT_HEAT_PUBLICATION_KEY_IDS`. For V3, add the key ID to
   `PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS`. Never change an existing
   key ID's platform or role. Deploy Convex first.
3. Verify the old worker can still authenticate, then atomically replace the
   matching V3, provider, publish, clear, retention, or Heat credential and
   restart safely. Rollback authority remains in the protected
   incident-operator path; exercise it with a signed status/rollback rehearsal
   rather than adding it to a steady worker. Keep every disabled provider
   credential until its dispatched operations and retention proof are fully
   reconciled.
4. Observe an authenticated status request and one terminal receipt under the
   new authority: V3 finalize, provider finalize/reuse, manifest publish, clear,
   rollback, retention, or Heat as applicable. Evidence records only the role,
   terminal receipt digest, and timestamps; never a key ID, authority map, or
   secret.
5. Keep old and new authority entries through all in-flight retries and for at
   least 15 minutes after the new-key terminal receipt. Remove the old entry
   only after the durable ledger proves zero retryable operations for that
   authority. Record the overlap proof, old-key retirement proof, and retirement
   time without recording the credential or protected binding.

An unknown-key alert during overlap means deployment ordering is wrong. Restore
the old worker key or re-add the old Convex map entry; do not disable signing.

## Rollback, clear, and settlement unblock authority

- A release operator may submit a signed rollback only to the retained previous
  complete manifest and must provide the exact expected active manifest. Heat
  becomes available only when a frame aligned to the resulting manifest and
  provider reference set exists.
- Clearing the catalog is destructive emergency authority. It requires incident
  commander approval, a signing key assigned the explicit `clear` role in
  `PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES`, and the
  `clear_catalog_manifest_v1` authorization in the signed request. Verify the
  empty pointer immediately after the terminal receipt; no global clear flag
  can grant or widen this authority.
- Only the owning derivation processor/data operator may retry or record a new
  terminal business outcome for a technical derivation. A release operator must
  not advance `settled_public_watermarks` or rewrite an obligation.
- A blocked manifest is corrected in approved PostgreSQL configuration or
  canonical data, producing a new causal sequence. It is never unblocked by
  editing Convex staging rows.

Record the approval reference, signed operation ID, before/after public pointer,
and terminal receipt digest. Do not record actor identity, tenant, key material,
or source data in the portable evidence bundle.

## Retention

Catalog retention is an authenticated, generation-CAS two-phase operation run
automatically by the production worker. The coordinator drives
`retain-manifests` to terminal completion before it drives
`retain-provider-releases` to terminal completion for each canonical platform
in the frozen PostgreSQL proof. A request selects only its phase, optional platform,
document limit, expected retention generation, and one complete canonical
PostgreSQL proof snapshot. It never supplies candidate or protection allow-lists;
Convex resolves and cross-validates every target from exact stored state.

The authoritative graph protects active and previous manifests, every provider
release embedded by every retained manifest, each platform's completed head,
the active manifest's provider heads, exact PostgreSQL in-flight attempts, and
authorized rollback or block recovery targets. The manifest-to-provider edge
table is only an index: every read compares it with the exact embedded manifest
references, and a missing, extra, mismatched, or orphan edge stops retention.
Pending or sent operation proof carries the exact canonical request and digest
with a null terminal-receipt SHA. Acknowledged proof must match the stored
Convex operation and its terminal-receipt SHA; stale pending or sent state for
an already acknowledged operation fails closed.

For manifests and for each platform independently, retain protected artifacts
plus at most three additional complete artifacts for seven days. An unprotected
complete artifact is eligible as soon as it exceeds either the count or age
allowance. Staging and failed artifacts become eligible after 24 hours. Each
mutation deletes at most 90 artifact-owned documents plus at most ten expired or
overflow retention-receipt rows, never more than 100 total. The retention
journal itself retains seven days and at most 128 exact receipts. Every cleanup
advances the dedicated retention generation even when public pointers and
completed heads are unchanged; replay after a receipt is pruned therefore
conflicts instead of selecting a later candidate.

PostgreSQL cleanup follows successful Convex cleanup. The coordinator acquires
or resumes the deployment retention barrier, whose database transaction first
refuses every live promotion claim; it never holds a database transaction across
the Convex request. Under the barrier, revalidate
the same exact protection snapshot and delete only the bounded, unreferenced
provider operation/attempt/evaluation/artifact graph through the retention-only
database API. Task-specific trigger authorization must be transaction-local and
server-set. Do not disable the immutable-artifact trigger or expose a general
delete bypass. A crash between Convex and PostgreSQL cleanup leaves harmless
extra PostgreSQL proof. The next cycle loads the acknowledged operation requiring
cleanup and continues its exact selected graph before preparing newer work.

Drive continuation using the signed receipt's `retentionGeneration`. Before any
network send, persist the exact canonical request as `sent`. On restart or an
ambiguous send, query signed retention status with the exact operation identity
and request digest. A terminal status receipt is acknowledged directly; only a
signed `not_found` status permits resending the same persisted request bytes.
Persist the canonical inner receipt and its SHA separately from the exact
received signed-envelope bytes.
Keep bootstrap, active/head, retained recovery, and status proof receipts; only
unreferenced bounded promotion artifacts are eligible for PostgreSQL cleanup.

Production Heat retention protects active/previous frames, their immutable
signal sets/signals, and the finalize/refresh proof receipts. Retired frames,
unreferenced signal sets/signals, completed publication/batch metadata, and
unprotected operations age out after seven days. Abandoned staging or failed
Heat publications become eligible at the frame expiry. The hourly cron and
authenticated `/internal/repack-heat/v1/retain` path delete bounded batches of
90 documents and continue when required. A frame also has an exact 15-minute
ID-and-expiry-bound scheduled callback; a stale callback cannot expire a newer
frame.

Normalized PostgreSQL Heat observations and dispositions retain exactly seven
days and are deleted by the independent bounded worker cycle. Promotion attempts,
exact request bytes, and terminal receipt proofs are durable launch/recovery
evidence and are not manually purged under this runbook.

If any protected pointer, edge, attempt, head, exact request, or receipt proof is
missing or inconsistent, catalog retention must fail closed with a stable
`CATALOG_RETENTION_*` error. Stop both phases, preserve the PostgreSQL barrier
state, and repair or rollback under incident authority; never delete around the
failed proof.

The worker performs at most the configured number of coordinator steps per
cycle. `bounded` and `retry_required` outcomes keep the barrier active and run at
the short continuation cadence; only a fully reconciled manifest phase, every
canonical provider phase, and all PostgreSQL cleanup permit `releaseBarrier` and
the normal hourly cadence. `SIGINT` or `SIGTERM` aborts the in-flight signed HTTP
request or sleep and joins the retention loop before the database pool closes.
Safe logs record only outcome, resumed-barrier flag, bounded step/request/count
totals, and a stable failure code. They never contain organization/deployment
binding, proof bodies, operation bytes, receipts, or credentials.

## Clean preproduction cutover

There is no dual read, dual write, optional-field compatibility path, or
authenticated runtime purge endpoint. Choose exactly one target path: prove a
brand-new dedicated deployment empty, or reset an existing deployment that
still contains the obsolete single-release catalog and pre-manifest Heat state.

### Brand-new dedicated Convex target

A newly created deployment dedicated to Packscout may receive the
provider-release, manifest, and manifest-aligned Heat schema before PostgreSQL
migration only while it is deliberately inert. Set
`PACKSCOUT_RUNTIME_ENVIRONMENT=preproduction`, leave all publication authority,
mock-seed, mock-Heat, and `PACKSCOUT_PUBLIC_ORIGIN_SET_HASH` variables absent,
and do not connect a worker, frontend, or admin service. Deploy from the exact
reviewed commit without a preview-run or seed command, then run:

```bash
npm run cutover:preflight:fresh-convex:preproduction -- \
  --deployment <explicit-preproduction-selector-or-deployment-name>
```

The verifier has no execute mode. It strips ambient Convex deployment and
deploy-key variables from child commands, supplies the explicit target to every
read, reads only environment-variable names plus the non-secret runtime value,
checks the closed list of every application table for any first document, and
requires the public shell to return `RELEASE_UNAVAILABLE`. Reserved `dev`,
`prod`, `default`, `local`, `production`, and `live` selectors are refused. Its
canonical JSON contains only bounded counts, stable public outcomes, and
domain-separated scope/table/proof digests; it never includes the deployment
selector, an environment value other than `preproduction`, a row, or a secret.

Require `status=passed`, `readOnly=true`, all 36 application tables empty, zero
forbidden variables, and the expected public-shell result. Retain the sanitized
proof and its digest with the target-creation audit record and exact deployed
commit. This proves only that the new Convex target is empty and fail-closed; it
does not authorize PostgreSQL migration, configuration approval, signing keys,
worker startup, or publication. Re-run it after any schema redeploy and
immediately before adding publication configuration. Once publication authority
or any application row exists, this branch is no longer valid.

Do not run the obsolete-state reset against a brand-new deployment. Final
Task 014 evidence still requires independently verified target backup/provenance
and unchanged PostgreSQL canonical, settlement, approved-configuration, and
normalized-Heat digests; record both obsolete deletion counts as zero for the
approved fresh-target path.

### Existing obsolete target reset

This is the one-time, prelaunch replacement path for obsolete single-release
catalog and pre-manifest Heat publication state. Run the reset **before**
PostgreSQL migration `20260816030000_heat_manifest_alignment` and before
deploying the provider-release/manifest Convex schema. That migration
deliberately refuses old Heat attempts whose content identity has no
manifest-source proof.

The reset command is preproduction-only and dry-run by default:

```bash
npm run cutover:reset:preproduction -- --dry-run
npm run cutover:reset:preproduction -- --execute
```

It accepts only `--dry-run` or `--execute`; the digest-print mode is documented
below. It refuses production/live environment markers, cloud deploy-key
variables, self-hosted Convex credentials, an unapproved database target, or a
Convex selector that does not end in the exact `preproduction` segment.

### Reset scope and preservation

The Convex portion is **deployment-wide**, not organization-filtered. It first
exports the selected deployment, verifies and syncs the backup, then replaces
only this closed table allowlist with an empty import:

- Obsolete catalog: `dataReleaseState`, `blockedDataReleaseManifests`,
  `dataReleaseOperations`, `dataReleaseBatches`,
  `dataReleaseCollectibleReconciliation`,
  `dataReleaseRepackReconciliation`, `dataReleasePublications`,
  `repackSearchShards`, `repackChases`, `collectibles`, `repacks`,
  `categories`, `vendors`, and `dataReleases`.
- Pre-manifest Heat publication state: `repackHeatState`,
  `repackHeatOperations`, `repackHeatBatches`, `repackHeatPublications`,
  `repackHeatSnapshots`, `repackHeatSignals`, and
  `repackHeatSignalSets`.

`dataReleaseAuthNonces` is intentionally preserved. Because the clear applies
to every document in those allowlisted tables, stop if the selected Convex
deployment is not dedicated to the single approved PackScout organization or
contains any state outside the approved cutover scope.

PostgreSQL deletion is narrower. In one serializable transaction, the utility
deletes child-first from `promotion_operations`, `promotion_attempts`, and
`promotion_lanes` only for the approved organization/deployment binding and the
obsolete `catalog` and `heat` lanes. It locks and proves unchanged all of the
following protected state before commit:

- `canonical_entities`, `canonical_relationships`, and `canonical_revisions`;
- `public_change_causes`, `public_change_catalog_impacts`,
  `public_derivation_obligations`, and `settled_public_watermarks`;
- `provider_catalog_checkpoints` and
  `catalog_manifest_lifecycle_checkpoints`;
- `approved_public_catalog_configurations` and
  `public_repack_identity_mappings`; and
- `normalized_heat_window_checkpoints`, `normalized_heat_observations`, and
  `normalized_heat_observation_outcomes`.

The utility records counts and domain-separated hashes, not protected rows. It
does not create a PostgreSQL backup; obtain and verify an independent target
recovery point before execution.

### Required target-bound inputs

Set these only in the protected operator environment. Never paste their values
into a ticket, terminal transcript, portable evidence, or this runbook.

```text
PACKSCOUT_CUTOVER_ENVIRONMENT=preproduction
PACKSCOUT_CUTOVER_DATABASE_ENVIRONMENT=preproduction
PACKSCOUT_CUTOVER_ORGANIZATION_ID
PACKSCOUT_CUTOVER_DEPLOYMENT_KEY
PACKSCOUT_CUTOVER_CONVEX_DEPLOYMENT
PACKSCOUT_CUTOVER_DATABASE_TARGET_SHA256
PACKSCOUT_CUTOVER_APPROVAL_REFERENCE
PACKSCOUT_CUTOVER_WORKERS_STOPPED=YES
PACKSCOUT_CUTOVER_EVIDENCE_FILE
PACKSCOUT_CUTOVER_BACKUP_DIRECTORY
PACKSCOUT_DATABASE_URL
```

The evidence file and backup directory must be absolute paths in a private
operator-controlled location. The approval reference is hashed before it is
written. Use the authenticated Convex operator session for the explicit
preproduction selector; do not supply a cloud deploy key to this command.

Calculate the password-free database target digest, have it approved out of
band, and then set the approved value:

```bash
npm run cutover:reset:preproduction -- --print-database-target-digest
```

The command hashes the normalized database target; it does not print the
database URL. A successful dry-run proves the database identity/schema,
organization binding, obsolete lane counts, absence of live or ambiguously sent
work, and before-reset protected-state digest. It emits a target-scope digest
and the exact target-bound confirmation phrase required for execution. Do not
construct or reuse a confirmation from another run.

### Execution order and stop conditions

1. Freeze changes to the approved organization/deployment binding. Stop every
   provider, manifest, retention, and Heat worker and independently verify no
   process can reclaim a lane.
2. Verify the independent PostgreSQL recovery point and private artifact paths.
   Confirm the currently deployed Convex schema is still the obsolete
   pre-manifest schema; do not run this utility after new publication begins.
3. Generate and approve the database target digest. Run the explicit dry-run
   and review its stable result plus append-only JSONL evidence.
4. Stop on any binding/schema/digest mismatch, missing target lane, unexpired
   active claim, `sent` operation, changed protected-state digest, or evidence
   write failure. Resolve the source condition; never edit ledger rows to make
   preflight pass.
5. Set `PACKSCOUT_CUTOVER_CONFIRMATION` to the exact phrase from that dry-run,
   retain the stopped-worker attestation, and run `--execute`. Execution repeats
   preflight, creates and durably verifies a full Convex export, clears each
   allowlisted Convex table in pointer-first order, then commits the scoped
   PostgreSQL deletion. Keep the backup ZIP, its SHA-256, and JSONL evidence.
6. Require the terminal reset stage `complete`, identical before/after protected
   PostgreSQL digest, expected scoped deletion counts, and the full Convex clear
   count. Do not infer success from an empty public response.
7. On the obsolete-target reset path, only now apply PostgreSQL migration
   `20260816030000_heat_manifest_alignment`,
   `20260826005000_source_relationship_confirmations`,
   `20260826010000_heat_relationship_causality`, and subsequent migrations, then
   deploy the provider-release, global-manifest, and manifest-aligned Heat
   Convex contracts. On the approved fresh-target path, keep Convex inert while
   applying those PostgreSQL migrations, deploy the exact final Convex commit if
   it changed, and repeat the fresh-target preflight before configuring
   publication authority.
8. While every worker remains stopped, open **Provider Sources** and choose **Reassert
   promotion identity** once for every source whose current state is `active`.
   This idempotent action appends the exact source-instance/source-revision
   lifecycle decision required by V1 promotion without changing the cursor or
   scheduling another run. Confirm every expected active platform appears in
   manifest eligibility before continuing. Promotion deliberately remains
   unavailable while an active or paused source has only legacy lifecycle
   causality; do not bypass that fence or interpret it as a disabled provider.
   If a source is fenced as **Action required**, repair it through **Disable →
   Test source → Activate paused → Resume**; the final resume publishes the
   source-native identity and must precede the eligibility confirmation.
9. Prove the new provider, manifest, and Heat publication state is empty.
10. Start only the new combined production worker. Its startup prerequisite
   must complete relationship confirmation discovery/materialization first and
   the normalized Heat relationship/catalog-order repair second. No sibling
   lane may claim work before that ordered prerequisite returns. Retain the
   exact complete/count-consistent SQL proof from **Initial backfill and
   enablement**. Stop on a missing, pending, running, failed, or inconsistent
   row; ordinary restarts resume the durable cursors and must not replay source
   pages. After the prerequisite releases the lanes, let authenticated
   bootstrap persist the exact proven-empty anchor, start provider completion,
   activate the first complete same-epoch manifest, and publish/read back one
   exactly aligned Heat frame.

The Convex clears and PostgreSQL transaction cannot be atomic with each other.
A failure before the first clear is non-destructive. Once a clear starts, the
utility returns `CUTOVER_RECOVERY_REQUIRED` and records the backup proof, last
completed table count, failure code, and whether PostgreSQL reset began. Keep
all workers stopped and do not rerun, migrate, or manually clear around that
state. The incident commander and Convex/PostgreSQL owners must use the durable
evidence to choose either authorized restoration or completion of the approved
reset.

Backup restoration is a cutover rollback only before the new schema has
accepted any provider, manifest, retention, or Heat write. After new
publication starts, never restore the obsolete schema or backup over live state;
use the signed manifest rollback, emergency clear, block, and retention
authorities described in this runbook. Any observed production data, second
organization, unknown document ownership, or missing recovery point is a hard
stop requiring a separately reviewed migration or recovery plan.

## Evidence levels and readiness matrix

Evidence must be labeled. Local fake evidence proves deterministic code paths;
it is not evidence of live credentials, network behavior, production volume, or
the one-minute service target.

| Level | What it can prove | What it cannot prove |
|---|---|---|
| Local automated | Contract validation, tenant scoping, deterministic hashes, durable retries, fake lost acknowledgements, pointer/retention invariants, Heat alignment/expiry | Live auth configuration, production latency, real provider completeness, hosted Convex limits |
| Preproduction live | Secret-manager wiring, real HTTPS/auth/status reconciliation, deployment binding, representative-volume timing, rollback and retention rehearsal | Production provider state and launch-day p95 |
| Production observation | Actual backfill readiness, active pointer/receipt, delayed-provider behavior, Heat cadence/expiry, p95 latency over the declared sample window | Nothing beyond the recorded window/volume |

Run these local gates from a clean integrated branch:

```bash
npm run test:contracts
npm run test:database
npm run test:services
npm run test:worker
npm run test:convex
npm run check:prisma
npm run verify:framework
```

The focused local volume gate is reproducible with:

```bash
node --import tsx --test \
  --test-name-pattern="8k provider completion activates one manifest with delayed fallback under one minute" \
  packages/services/src/provider-promotion-runner.test.ts
```

It constructs a real provider publication plan containing 8,000 collectibles,
drives every bounded provider operation through completion, composes the next
global manifest with a delayed provider's active fallback, and requires the
provider-plus-manifest cycle to finish locally within one minute. Its reported
duration is in-memory planning/transport CPU evidence only. It excludes
PostgreSQL snapshot loading, scheduling, HTTPS, hosted Convex execution, and
remote confirmation, so it cannot prove settled-to-confirmed p95.

The separate eight-platform public read bound is covered by:

```bash
npx vitest run convex/publicEightProviderCertification.test.ts
```

That local test exercises the unchanged dashboard, facets, sorting, details,
desired-collectible matching, collectible search, pagination, and exact active
manifest graph at eight providers under Convex transaction-limit simulation.

The local mock flow is explicitly fake:

```bash
npm run dev:frontend:mock-heat:local
```

Do not copy mock release IDs, simulated Heat, loopback timing, or local secrets
into a live readiness claim.

### Offline readiness certification

The readiness certifier validates a supplied sanitized JSON file. It does not
connect to PostgreSQL, Convex, a secret manager, a deployment supervisor, or a
monitor, and it does not collect or manufacture hosted evidence:

```bash
npm run cutover:certify:preproduction -- \
  /absolute/private/path/provider-manifest-readiness.json \
  > /absolute/private/path/provider-manifest-readiness.certified.json
```

The input must use schema
`packscout.provider-manifest-readiness.v1`, be at most 2 MiB, and declare
`preproduction` or `production`; local evidence is explicitly rejected. The
strict schema rejects unknown fields and protected field names or values,
including identifiers, URLs, connection strings, credentials, key IDs,
headers, nonces, payloads, actor/tenant fields, and raw or quarantine material.
Supply only approved digests, bounded public platform keys, counts, watermarks,
stable codes, and ISO timestamps.

A certifiable hosted input includes all of the following:

- reset proof with a verified backup digest, proven-empty new publication
  state, obsolete document/row counts, and matching before/after digests for
  canonical PostgreSQL state, causal settlement, approved configuration, and
  normalized Heat;
- one exact entry for every enabled platform with affected-settled, completed,
  and active watermarks plus content, request, and terminal-receipt digests;
- the active/previous manifest hashes, canonical provider-reference-set hash,
  aggregate counts/hashes, pointer result, public DTO hash, and request/receipt
  digests;
- an exactly aligned Heat frame and provider-reference-set hash, signal/frame
  counts and hashes, source watermark, receipt proof, and the observed
  unavailable-after-15-minutes outcome;
- retention and rollback proofs covering active/previous, completed heads,
  shared and in-flight references, recovery targets, mutation bounds, and the
  restored manifest pointer;
- external `processDown` and `heatNotAdvancing` monitor events that each fire
  before the 15-minute Heat expiry boundary and resolve after recovery;
- at least 20 hosted provider-to-manifest samples and 20 hosted Heat samples,
  using nearest-rank ceiling percentiles, with zero errors and p95 strictly
  below 60,000 ms in both lanes; and
- a full 40-character launch commit plus sorted, allowlisted zero-exit command
  results, including `npm run verify:framework` on that exact commit.

Rotation evidence contains one least-privilege role and its overlap, new-key
terminal, zero-retryable-work retirement, and old-key-retirement proof. Rehearse
and retain a separate certified envelope for each authority used at launch:
provider, manifest publish, manifest clear, manifest rollback, retention, and
Heat (the JSON role values are `provider`, `manifest_publish`,
`manifest_clear`, `manifest_rollback`, `retention`, and `heat`). The final
readiness package is incomplete if any authority is missing.

On success, stdout is a canonical JSON envelope containing the artifact and its
SHA-256; stderr is a redacted one-line summary with p95 values, maximum monitor
fire latency, abbreviated commit, and artifact digest. A stable
`EVIDENCE_*` code means the input was refused. Certification proves only the
quality and consistency of the supplied hosted evidence; preserve the source
monitor, secret-manager, reset, and timing records under their protected
retention policy.

| Launch scenario | Required sanitized evidence | Gate |
|---|---|---|
| Startup/configuration | Stable success or `*_INVALID` code for every required setting; exact migration readiness | Must pass in preproduction and production |
| Initial activation | Backfill/config/mapping approval outcome, settled/requested/confirmed watermarks, content hash/counts, request digest, terminal receipt digest | Must pass live before public enablement |
| Full versus incremental rebuild | Equal catalog public hash and counts at the same settled watermark | Must pass locally and in preproduction |
| Restart, stale lease, replay, lost acknowledgement | One terminal outcome, no duplicate/regressed pointer, exact status-first receipt | Must pass locally and in preproduction |
| Auth, contract, hash, count, and manifest failures | Prior pointer remains readable plus durable safe failure/recovery alerts | Must pass locally; auth also in preproduction |
| Rollback and emergency clear | Approval reference, before/after pointer, signed receipt digest, protected retention proof | Rehearse rollback in preproduction; clear only under incident authority |
| Key rotation | Per-authority overlap deployment, new-key status and terminal receipt, zero retryable operations, and old-key retirement proof for provider, publish, clear, rollback, retention, and Heat | Must pass in preproduction before live rotation |
| Catalog retention | Active/previous/completed-head/in-flight/recovery targets preserved; shared references survive; every mutation stays at or below 100 documents; bounded continuation and exact status replay complete | Must pass locally and in preproduction |
| Heat alignment and expiry | Frame manifest hash/provider-reference-set hash, sequence, aggregate hash/count, calculation/expiry times, unavailable result after 15 minutes | Must pass locally and in preproduction |
| Representative volume | Volume, batch counts/bytes, settled-to-confirmed samples, p50/p95/max, error count | Preproduction required; repeat in production |

For the catalog one-minute goal, measure from `settled_at` to the matching
activated or unchanged confirmation time. For Heat, measure consecutive exact
minute boundaries to confirmed frame time. Record sample count, observation
window, volume, p50, p95, maximum, and failures. Do not state that p95 is met
until live or representative preproduction measurements prove it; local unit
test duration is not publication latency.

The portable evidence bundle may contain only fixture/version labels, bounded
public platform keys, watermarks/sequences, public content and aggregate
hashes/counts, request and terminal-receipt digests, pointer results, safe
failure codes, timing samples, and allowlisted commands. Remove database URLs,
organization/deployment identifiers, provider display names or internal IDs,
raw payloads/observations, actors, tenants, run/quarantine IDs, headers, nonces,
and all key material before review.
