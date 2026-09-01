# DataForrest catalog bridge

Status: production drain, catalog cutover, event successor, and operator artifact producers implemented

The exact operator commands and private-artifact contract are documented in
[`docs/dataforrest-catalog-bridge-operator-artifacts.md`](../../docs/dataforrest-catalog-bridge-operator-artifacts.md).

Collector Crypt, Courtyard, and Phygitals each have one provider-local runtime
cursor. A catalog request cursor and the ordinary event request cursor are scoped
to different immutable request profiles. The catalog bridge therefore cannot add
`stream=catalog` to an active event revision or reuse its cursor.

`dataforrest-catalog-bridge-plan.mts` defines the fail-closed sequence:

1. Pin a clean resident commit and utility module hash.
2. While the resident is still live, submit one reviewed operator `pause`, let the
   active run settle, and bind the completed command to the resulting paused
   generation. Accept either the two audited interruption terminals with their
   last committed `more` page, or a distinct succeeded/reconciled-head proof.
3. Only after that paused boundary is durable, gracefully unload exactly one
   provider resident. Prove there is no process, residency listener, active run,
   actionable command, import lease, other owned lease, or other active
   transaction. The runtime must remain paused.
4. Preserve the event cursor only in `private-state.json`. Public receipts contain
   its database fingerprint and opaque-value digest, never the cursor.
5. Require fresh bounded canaries at catalog origin and at the saved event cursor.
6. Stage and activate a higher catalog config whose settings are exactly
   `{ platform: providerKey, stream: "catalog" }`; provider configuration sync
   must clear the config-scoped cursor.
7. Use a dedicated paused-origin resume guard, acquire the exact live utility
   lease, resume to idle, and queue one deterministic catalog run with a null
   origin cursor. Accept only a succeeded
   head whose raw valid card and pack source observations are each distinct and
   exactly equal the pinned counts, with zero pull/trade/quarantine records and
   unchanged pull and market-event counts and row digests. The run-scoped adapter
   census binds an ordered page-chain digest and an identity-multiset digest into
   the final journal receipt; source IDs are hashed and never written to evidence.
   Each page digest sorts only that bounded page. The session retains one count-map
   entry per distinct hashed source identity and computes the cumulative multiset
   digest once, only at head.
8. After the catalog run ends idle, submit and bind a second exact pause command.
   Keep the offline runtime paused and stage a still-higher event successor config
   while catalog remains active.
9. Synchronize the event successor, safely re-envelope the private saved cursor,
   restore it under the provider lock/CAS boundary, and activate central authority
   last.
10. Under a guarded paused-entry resume, acquire the exact live utility lease,
    resume and request the deterministic first successor event run using the
    restored cursor, then release the lease and launch the successor resident.
    Accept the run only when it starts from that cursor and reaches head.

The source head counts are manually reviewed exact operation pins, recorded with
the provenance value `manually_reviewed_exact_source_head_counts_v1` in the policy,
prepared receipt, and completed receipt. They are not an independently captured
source-head digest. If cards or packs arrive, disappear, or repeat during the
catalog run, exact raw/distinct/pin equality fails while the provider remains
offline. Do not loosen the counts or edit the journal. Capture fresh canaries and
create a newly reviewed successor operation with a new operation ID. An
independently captured preflight source-head digest remains a future hardening
step and must be produced through the same exact audited catalog adapter.

The catalog one-shot is deliberately non-resumable across a process restart. Its
orchestrator shares one in-memory, run-scoped census session across the fresh
executor/source created for each routed page. Catalog page 1 requires both the
source checkpoint and its fingerprint to be null. Every later page requires the
non-null checkpoint fingerprint emitted by the preceding page in that same
session. A page-K restart, or a nominal page-1 start with a persisted page-K
cursor, refuses before an upstream request. Preserve the failed operation and
keep the resident offline and paused; do not reuse its journal or run ID.

The current bridge does not automate recovery from that terminal one-shot
failure. A truly fresh reviewed recovery must capture new authoritative
preparation evidence and exact pins, allocate a new operation/config/run identity,
stage a strictly higher catalog config revision, and synchronize that new revision
into the paused provider runtime while holding the no-work boundary. That
configuration change must clear both `provider_runtime.source_cursor` and
`source_cursor_hash`; prove both are null before activating the central config
last, then admit the new deterministic run through a new paused-origin guard from
page 1. Same-version synchronization or simply queueing another run is forbidden:
same-version synchronization does not reset a persisted cursor.

## Implemented boundary

The generic drain core records an operation-owned intent, submits the ordinary
provider `pause` command, waits for the exact run to become terminal and the
runtime to remain paused, proves all actionable work and the import lease are
gone, and only then admits an injected launchd bootout. It verifies the exact
process identity, launchd label, PID, and residency port before bootout and proves
the process and port are gone afterward. The idle-at-head race path unloads the
resident first and performs the normal pause while offline; any queued or active
work that appears in that window refuses the operation. It never sends a signal
directly.

The preparation CLI validates a mode-`0600` private input, independently checks
the resident checkout commit, cleanliness, and bridge-module hash, then either
performs a read-only validation or writes a mode-`0700` private journal. It does
not write to either database, call the provider, unload a process, or start an
import.

```bash
node --import tsx scripts/live/prepare-dataforrest-catalog-bridge.mts \
  --check-only \
  --input /absolute/private/catalog-bridge-input.json \
  --journal-directory /absolute/private/catalog-bridge-journal
```

Replace `--check-only` with `--prepare` only after the exact input was produced by
a reviewed live snapshot/canary reader. Preparation writes:

- `private-state.json`: raw saved event cursor and complete preflight evidence;
- `public-journal.json`: hash-only receipt chain;
- `commit.json`: digests binding the two documents.

All files are mode `0600`. A crash before `commit.json` may be retried only with
byte-equivalent logical evidence. Any changed existing file refuses the retry.

The live drain entry point is `run-dataforrest-catalog-bridge-drain.mts`. Its
strict mode-`0600`, no-symlink policy pins the exact provider and active config,
central provider row and authority digest, provider route digest, runtime
generation and row version, run and worker fence, saved cursor hash, import
lease owner/fence, launchd PID, process identity, private receipt path, clean
executor checkout and commit, and exact drain-runner module SHA-256. The
policy contains no database URL, credential, or raw cursor. It is provider-data
driven through `catalogBridgeProviderDefinitions`; the adapter has no
provider-key branches.

`--check-only` opens both databases read-only, observes launchd/`ps`/`lsof`, and
validates every pin without writing an audit, submitting a command, or executing
`launchctl bootout`:

```bash
NODE_ENV=production node --import tsx \
  scripts/live/run-dataforrest-catalog-bridge-drain.mts \
  --check-only \
  --policy-file /absolute/private/catalog-bridge-drain-policy.json
```

The apply form also requires the independently reviewed policy digest:

```bash
NODE_ENV=production node --import tsx \
  scripts/live/run-dataforrest-catalog-bridge-drain.mts \
  --apply \
  --policy-file /absolute/private/catalog-bridge-drain-policy.json \
  --policy-sha256 64_LOWERCASE_HEX_CHARACTERS
```

Apply first persists one immutable pause intent under a Serializable provider
transaction using the lock order import lease, exact run, runtime. It submits
the ordinary pause through `PrismaAdminProviderRuntimeRepository`, reads the
completed command through the same repository, and persists the final receipt
both in provider-local audit and the private mode-`0600` receipt file. Exact
retries reconcile either side of a crash between those two writes. A macOS
adapter re-reads an admitted paused or succeeded-idle-head boundary immediately
before bootout, verifies launchd label, PID, process start/command identity and
the residency listener, executes only `launchctl bootout`, then proves the
label, process and port are absent. It has no direct-signal path.

## Live stages

The catalog and event-successor stages below are implemented without changing
their reviewed order:

- a read-only snapshot/canary capture that creates the preparation input;
- inactive central catalog config creation and activation proof;
- provider `synchronizeConfiguration` followed by central catalog CAS;
- deterministic one-shot worker execution and catalog-head census;
- inactive event-successor config and proof;
- provider sync, locked cursor restore, then central event-successor CAS;
- launchd resume and deterministic first-run acceptance;
- durable receipt persistence after every step.

The database command path now has a distinct `paused_catalog_origin` guard. It
admits only an explicit null cursor and atomically verifies the exact catalog
configuration, runtime row version and generation, latest terminal-run digest,
operation-owned pause-command digest, zero active/actionable work, a live fenced
utility import lease, and a database-clock deadline. It binds the reviewed
catalog-activation receipt digest into the immutable guard audit. It writes the
normal resume command and its guard audit in the same serializable transaction. A
retry after that transition must match the guard audit exactly; queueing must pass `expectedCursorFingerprint: null`,
`requireNoActiveRun: true`, the resulting generation, exact catalog config, and
the same live lease. Do not substitute an unguarded resume or omit the explicit
null cursor pin.

The driver keeps the resident offline after any refusal. It must never log a
source credential, response body, authorization header, raw request cursor, or raw
saved cursor.

## Acceptance map

| Scenario | Coverage |
|---|---|
| Exact current config and clean resident are required | Automated: `dataforrest-catalog-bridge-plan.test.mjs` |
| Active work, lease, process, cursor, or canary drift refuses preparation | Automated: `dataforrest-catalog-bridge-plan.test.mjs` |
| Initial pause binds exact command and terminal-run/last-page provenance | Automated: `dataforrest-catalog-bridge-drain.test.mjs` |
| Bootout occurs only after paused/no-work/no-lease proof | Automated: `dataforrest-catalog-bridge-drain.test.mjs` |
| Idle-head queued-work race refuses while offline | Automated: `dataforrest-catalog-bridge-drain.test.mjs` |
| A pause-race reconciled head uses a distinct proof policy | Automated: both drain and plan tests |
| Catalog authority contains the explicit catalog stream | Automated: `dataforrest-catalog-bridge-plan.test.mjs` |
| Raw cursor stays out of public receipts and CLI output | Automated: both bridge tests |
| Head accepts only exact catalog entities and unchanged event evidence | Automated: `dataforrest-catalog-bridge-plan.test.mjs` |
| Raw source, normalized, card, pack-membership, and catalog audit counts remain consistent | Automated: `dataforrest-catalog-bridge-catalog-live.test.mjs` |
| Routed pages share one census; page-K restart and page-1 persisted cursor refuse before source I/O | Automated: `provider-dataforrest-mixed-page-source.test.ts` |
| Census digest work is bounded per page and the cumulative digest runs once at head | Automated: `provider-dataforrest-mixed-page-source.test.ts` |
| Transitions are ordered and exact retries are idempotent | Automated: `dataforrest-catalog-bridge-plan.test.mjs` |
| Catalog execution cannot be recorded without a paused-origin guard receipt | Automated: `dataforrest-catalog-bridge-plan.test.mjs` |
| Event-successor staging/restoration bind the second post-catalog pause | Automated: `dataforrest-catalog-bridge-plan.test.mjs` |
| Partial journal writes resume only with identical evidence | Automated: `dataforrest-catalog-bridge-journal.test.mjs` |
| Null-origin resume is atomic, fenced, and exactly replayable | Automated: `provider-runtime-catalog-origin-resume-guard.test.ts` |
| Live central/provider drain locks, immutable intent/receipt, and macOS bootout | Automated: `dataforrest-catalog-bridge-drain-live-adapter.test.mjs` |
| Catalog/event-successor central CAS and one-shot process execution | Automated: `dataforrest-catalog-bridge-catalog-live.test.mjs` |
| Fresh operation identity and every deterministic descendant are unused before drain | Automated: drain live-adapter and operator-materialization tests |
| Drain executor commit and runner bytes are exact before any live dependency opens | Automated: `dataforrest-catalog-bridge-operator-materialization.test.mjs` |
| Preparation canaries redact credentials/cursors and zero protected response bytes | Automated: `dataforrest-catalog-bridge-operator-materialization.test.mjs` |
| Successor plist includes awaited first run and its raw bytes are policy-bound | Automated: operator-materialization and bootstrap-macOS tests |
| Per-provider full-census timeouts exactly match reviewed counts and adapter bounds | Automated: execution-budget and catalog-live tests |
