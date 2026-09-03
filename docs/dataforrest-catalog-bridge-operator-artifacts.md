# DataForrest catalog bridge operator artifacts

Status: implemented artifact workflow for Collector Crypt, Courtyard, and
Phygitals; two-pass source-census capture is currently Collector Crypt only;
not a live-readiness certificate

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

Source-census proofs, policy files, preparation inputs, journals, drain receipts,
and staged plists are mode `0600`. The producer CLIs refuse symlinks, unsafe
parent directories, conflicting retries, relative paths, and dirty or unexpected
executor commits. Raw source cursors occur only in the preparation input and
private journal. Credentials and raw source responses are never written or
printed.

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

## Operation identity

Generate one fresh operation UUID before capturing source evidence. Use that
same UUID for the census, drain policy, preparation, journal, and every derived
artifact. Do not capture a census first and assign it to an operation later.

## Collector Crypt source census

Before draining Collector Crypt, capture the exact source head from the clean
checkout that will execute the operation:

```bash
npm run capture:dataforrest-catalog-census:live -- \
  --capture \
  --provider-key collector_crypt \
  --operation-id '<fresh UUID>' \
  --executor-checkout '<absolute clean checkout>' \
  --executor-commit '<exact 40-character commit>' \
  --output '<absolute source census path>'
```

This read-only command performs two complete null-origin catalog traversals,
strictly one after the other. Do not run another manual source tool concurrently.
Each request is bounded to the immutable Collector Crypt catalog-v2 limit of 100
records, and the command performs no database writes or process changes.

If the command result is lost after the proof is written, repeat the exact same
command. The producer validates the existing canonical proof against the
operation, checkout, commit, module hashes, and source definition, then returns
`already_captured` before opening database or source dependencies. A malformed,
unsafe, or differently bound output refuses without another source traversal.

Both passes must agree exactly on the card and pack counts, page and cursor
traversal evidence, and identity-multiset digest. The owner-only proof binds the
clean checkout, commit, census module hashes, source authority and credential
digest, and request bounds. It contains hashes and counts, not raw source IDs,
cursors, or response bodies. Agreement proves a reproducible observed head; it
is not a transactional snapshot of the mutable upstream catalog.

Retain both `sourceCensusFileSha256` and `sourceCensusProofDigest` printed by the
command. Preparation accepts the raw file SHA-256 as
`--source-census-sha256` and independently derives and binds the canonical proof
digest.

The proof is bound to that one operation UUID. Preparation refuses an attempt to
replay it into a different operation before opening database dependencies or
making source requests. A failed operation or recovery attempt therefore needs
both a new operation UUID and a new two-pass census.

The source-census producer currently accepts only `collector_crypt`. Do not use
the preparation workflow for Courtyard or Phygitals until equivalent census
capture support and evidence have been reviewed.

## Per-provider sequence

Using the same operation UUID bound into the census, capture the drain policy
from the exact clean checkout that will execute the operation:

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
the preparation input using the pre-drain census proof:

```bash
NODE_ENV=production node --import tsx \
  scripts/live/capture-dataforrest-catalog-bridge-preparation.mts \
  --capture \
  --drain-policy-file '<absolute drain policy path>' \
  --drain-policy-sha256 '<canonical drain policySha256>' \
  --source-census-file '<absolute source census path>' \
  --source-census-sha256 '<sourceCensusFileSha256>' \
  --output '<absolute preparation input path>'
```

This producer verifies the census file and its authority, checkout, commit,
credential digest, counts, and identity-multiset digest against the drain policy.
It also verifies the drain receipt, takes a canonical database baseline, captures
one catalog-origin canary and one saved-event-cursor canary, then rechecks the
offline paused boundary and credential digest. It performs exactly two bounded
source requests and no database or launchd mutation.

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

The one-shot catalog census is bounded from the source-census proof's exact counts
and immutable adapter request profile. The calculation uses the minimum
full-census page count, every request's 10-second ceiling, 50 percent processing
headroom, 30 minutes for activation/reconciliation/canonical evidence, and rounds
up to 15 minutes. Policies cannot exceed 48 hours.

| Provider | Documented catalog floor | Page limit | Pages at floor | Timeout at floor |
|---|---:|---:|---:|---:|
| Collector Crypt | 191,452 | 100 | 1,915 | 8 hours 30 minutes |
| Phygitals | 276,862 | 100 | 2,769 | 12 hours 15 minutes |
| Courtyard | 1,056,650 | 100 | 10,567 | 44 hours 45 minutes |

These floor-based values are planning minima, not current source evidence or
expected durations. The materialized policy derives its refusal ceiling from the
exact census-pinned counts, so a larger observed head can increase it up to the
48-hour cap. Any request, translation, or atomic commit failure remains terminal
for the one-shot operation. Preserve the failed artifact set and stop rather than
reusing an incomplete operation.

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

The bridge one-shot census is deliberately non-resumable. An interruption after
page 1 cannot restart at page K, and an incomplete journal, catalog config, run
ID, or cursor must not be reused. Keep the resident offline and paused. Recovery
requires a new two-pass source proof, a new operation and deterministic descendant
identities, a strictly higher catalog config, a cleared catalog cursor, and a new
null-origin admission from page 1.

## Mandatory non-live rehearsal

The dependency-injected rehearsal core runs the real drain, catalog-stage, and
event-resume cores against caller-owned adapters. It always emits
`non_certifying_hybrid`, regardless of the adapter evidence supplied, because it
cannot attest that its own external dependencies are genuine. It is not a
standalone certification executable. Only a separate external attesting host
binder could verify the clean commit, migrated disposable central and provider
database clones over production-shaped remote-TLS routes, isolated macOS process
host or VM, and live DataForrest API and then produce certification evidence.
That binder is not implemented here. The reviewed rehearsal evidence must
include:

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

The current Collector Crypt recovery policy is fixed to config 3. It cannot
produce the strictly higher fresh catalog configuration required for the recovery
operation after an injected mid-census interruption. The rehearsal must report
`CATALOG_BRIDGE_REHEARSAL_FIXED_CONFIG_3_RETRY_UNSUPPORTED`, remain
`non_certifying_hybrid`, and leave live apply unauthorized until that blocker is
removed and the complete production-shaped evidence is reviewed.
