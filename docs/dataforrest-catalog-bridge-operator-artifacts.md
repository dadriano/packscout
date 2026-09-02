# DataForrest catalog bridge operator artifacts

Status: implemented artifact workflow for Collector Crypt, Courtyard, and
Phygitals; not a live-readiness certificate

The catalog bridge is a sequential, fail-closed operation. Each provider uses a
fresh operation UUID and its own private artifact directory. Finish and verify
one provider before capturing a drain policy for the next provider.

Do not treat successful materialization or `--check-only` output as authorization
to run `--apply`. The exact commit and artifact chain require the non-live
rehearsal and independent review described below before any live operation.

## Private artifact root

Create the artifact root outside the repository and make it owner-only:

```bash
umask 077
mkdir '<absolute unique artifact directory>'
chmod 700 '<absolute unique artifact directory>'
```

Policy files, preparation inputs, journals, drain receipts, and staged plists
are mode `0600`. The producer CLIs refuse symlinks, unsafe parent directories,
conflicting retries, relative paths, and dirty or unexpected executor commits.
Raw source cursors occur only in the preparation input and private journal.
Credentials and raw source responses are never written or printed.

## Fresh capability proof

After the final code commit is clean and its focused checks have passed, capture
one fresh read-only capability proof:

```bash
NODE_ENV=production node --import tsx \
  scripts/live/capture-dataforrest-catalog-bridge-capabilities.mts \
  --capture \
  --output '<absolute capability proof path>'
```

The proof contains database capabilities and safe estimates. It performs no
source requests and no database writes.

## Per-provider sequence

Generate a fresh operation UUID. Capture the drain policy from the exact clean
checkout that will execute the operation:

```bash
NODE_ENV=production node --import tsx \
  scripts/live/capture-dataforrest-catalog-bridge-drain-policy.mts \
  --capture \
  --provider-key '<collector_crypt|courtyard|phygitals>' \
  --operation-id '<fresh UUID>' \
  --operator-id '<reviewed operator UUID>' \
  --executor-checkout '<absolute clean checkout>' \
  --executor-commit '<exact 40-character commit>' \
  --receipt-path '<absolute drain receipt path>' \
  --output '<absolute drain policy path>'
```

The producer pins the checkout, commit, drain-runner module hash, current
central authority, provider route, runtime generation and row version, source
cursor hash, exact run and lease fence, and the single resident process.

Use the canonical `policySha256` printed by the producer. It is the digest of
the parsed policy object and is intentionally different from the raw policy
file SHA-256:

```bash
NODE_ENV=production node --import tsx \
  scripts/live/run-dataforrest-catalog-bridge-drain.mts \
  --check-only --policy-file '<absolute drain policy path>'

NODE_ENV=production node --import tsx \
  scripts/live/run-dataforrest-catalog-bridge-drain.mts \
  --apply --policy-file '<absolute drain policy path>' \
  --policy-sha256 '<canonical policySha256>'
```

After the drain receipt exists and the provider is paused and offline, capture
the preparation input. The two counts are separately reviewed exact source-head
counts, not database estimates:

```bash
NODE_ENV=production node --import tsx \
  scripts/live/capture-dataforrest-catalog-bridge-preparation.mts \
  --capture \
  --drain-policy-file '<absolute drain policy path>' \
  --drain-policy-sha256 '<canonical drain policySha256>' \
  --source-head-card-count '<exact count>' \
  --source-head-pack-count '<exact count>' \
  --output '<absolute preparation input path>'
```

This producer verifies the drain receipt, takes a canonical database baseline,
captures one catalog-origin canary and one saved-event-cursor canary, then
rechecks the offline paused boundary and credential digest. It performs exactly
two bounded source requests and no database or launchd mutation.

Prepare the immutable journal:

```bash
node --import tsx scripts/live/prepare-dataforrest-catalog-bridge.mts \
  --check-only \
  --input '<absolute preparation input path>' \
  --journal-directory '<absolute journal directory>'

node --import tsx scripts/live/prepare-dataforrest-catalog-bridge.mts \
  --prepare \
  --input '<absolute preparation input path>' \
  --journal-directory '<absolute journal directory>'
```

Materialize the exact successor plist and the catalog live policy together:

```bash
node --import tsx \
  scripts/live/materialize-dataforrest-catalog-bridge-live-policy.mts \
  --materialize \
  --journal-directory '<absolute journal directory>' \
  --capability-proof '<absolute capability proof path>' \
  --node-path '<absolute node executable>' \
  --log-path '<absolute successor log path>' \
  --staged-plist-path '<private directory>/com.packscout.provider-import.<provider>.plist' \
  --installed-plist-path "$HOME/Library/LaunchAgents/com.packscout.provider-import.<provider>.plist" \
  --output-policy '<absolute catalog live policy path>'
```

The staged and installed plist basenames must exactly match the provider label.
The materializer generates `--bootstrap-backfill --await-initial-run`, binds the
raw plist SHA-256 into the strict live policy, and lints the exact staged bytes.
It does not install or bootstrap the plist.

Run check-only before apply and use the materializer's canonical policy digest:

```bash
NODE_ENV=production node --import tsx \
  scripts/live/run-dataforrest-catalog-bridge-catalog.mts \
  --check-only --policy-file '<absolute catalog live policy path>'

NODE_ENV=production node --import tsx \
  scripts/live/run-dataforrest-catalog-bridge-catalog.mts \
  --apply --policy-file '<absolute catalog live policy path>' \
  --policy-sha256 '<canonical policySha256>'
```

Do not start the next provider until the journal phase is `resumed`, exactly one
resident/listener is present, the deterministic successor run is the verified
succeeded head, and no actionable work or import lease remains.

## Full-census timeout evidence

The one-shot catalog census is bounded from the reviewed source-head counts and
immutable adapter request profile. The calculation uses the minimum full-census
page count, every request's 10-second ceiling, 50 percent processing headroom,
30 minutes for activation/reconciliation/canonical evidence, and rounds up to
15 minutes. Policies cannot exceed 48 hours.

| Provider | Reviewed records | Page limit | Minimum pages | Bounded timeout |
|---|---:|---:|---:|---:|
| Collector Crypt | 191,452 | 100 | 1,915 | 8 hours 30 minutes |
| Phygitals | 276,862 | 100 | 2,769 | 12 hours 15 minutes |
| Courtyard | 1,056,650 | 100 | 10,567 | 44 hours 45 minutes |

These are refusal ceilings, not expected durations. Any request, translation,
or atomic commit failure remains terminal for the one-shot operation. Preserve
the failed artifact set and stop rather than reusing an incomplete operation.

For the bridge-selected Collector Crypt catalog-v2 profile, 100 is the effective
catalog request ceiling. The one-shot uses the lower of the catalog adapter bound
and its runtime resource ceiling; no policy field or operator flag may increase
it. The ordinary 1,000-record event profile and retained catalog-v1 profile are
different immutable request profiles and are not evidence that a 1,000-record
catalog response is admissible.

Collector Crypt config 3, its authority, and its saved event cursor envelope are
immutable distributed-v1 state. Drain and preparation resolve that exact v1
tuple, while the fresh compatibility probe at the saved cursor is interpreted by
the distributed-v2 successor that will consume it. The event successor and
re-enveloped cursor then use distributed v2. Both tuples remain installed only
for this transition. Remove distributed-v1 execution support after the completed
bridge proves central/provider v2 authority, the restored successor run at head,
and no active configuration, run, or saved cursor still references v1.

The census is deliberately non-resumable. An interruption after page 1 cannot
restart at page K, and an incomplete journal, catalog config, run ID, or cursor
must not be reused. Keep the resident offline and paused. Recovery requires fresh
authoritative evidence and counts, a new operation and deterministic descendant
identities, a strictly higher catalog config, a cleared catalog cursor, and a new
null-origin admission from page 1.

## Mandatory non-live rehearsal

Repository tests validate the artifact schemas, fail-closed transitions, database
adapters, and process boundaries with fixtures. They do not certify the exact
live operation. Before requesting live authorization, run the exact clean commit
through the complete operator sequence using disposable, migrated central and
provider databases plus an isolated process harness. The reviewed rehearsal
evidence must include:

1. Capability, drain-policy, preparation, journal, live-policy, and successor
   plist artifacts bound to one clean commit and their canonical digests.
2. Successful `--check-only` execution at every boundary without database or
   process mutation.
3. A complete Collector Crypt catalog census at no more than 100 records per
   request, with recorded page count, peak response size, elapsed time, exact
   card/pack identity counts, and zero quarantine.
4. An injected mid-census interruption proving the resident remains offline and
   paused and that the failed operation cannot resume or reuse its artifacts.
5. Fresh-operation recovery from page 1, followed by event-cursor restoration,
   deterministic successor-run acceptance, launchd bootstrap, and final handoff.

Archive the sanitized rehearsal evidence for independent review. Until every
item is reviewed and an operation-specific approval is recorded, do not run a
live `--apply` command.
