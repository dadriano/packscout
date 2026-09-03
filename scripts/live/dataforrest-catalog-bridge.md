# DataForrest catalog bridge

Status: Collector Crypt two-pass source census, drain, catalog cutover, event
successor, and operator artifact producers implemented; live readiness is not
certified by this document

The exact operator commands and private-artifact contract are documented in
[`docs/dataforrest-catalog-bridge-operator-artifacts.md`](../../docs/dataforrest-catalog-bridge-operator-artifacts.md).
The presence of those commands is not authorization to run `--apply`. A reviewed
non-live rehearsal and operation-specific approval are still required.

Collector Crypt, Courtyard, and Phygitals each have one provider-local runtime
cursor. A catalog request cursor and the ordinary event request cursor are scoped
to different immutable request profiles. The catalog bridge therefore cannot add
`stream=catalog` to an active event revision or reuse its cursor.

`dataforrest-catalog-bridge-plan.mts` defines the fail-closed sequence:

1. Allocate one fresh operation UUID, then pin a clean resident commit and utility
   module hash.
2. Before draining, use that operation UUID and exact clean checkout to read the
   Collector Crypt catalog from null origin twice, sequentially. Require exact
   agreement on card and pack counts, page/cursor traversal, and the
   identity-multiset digest.
3. While the resident is still live, submit one reviewed operator `pause`, let the
   active run settle, and bind the completed command to the resulting paused
   generation. Accept either the two audited interruption terminals with their
   last committed `more` page, or a distinct succeeded/reconciled-head proof.
4. Only after that paused boundary is durable, gracefully unload exactly one
   provider resident. Prove there is no process, residency listener, active run,
   actionable command, import lease, other owned lease, or other active
   transaction. The runtime must remain paused.
5. Preserve the event cursor only in `private-state.json`. Public receipts contain
   its database fingerprint and opaque-value digest, never the cursor.
6. Require fresh bounded canaries at catalog origin and at the saved event cursor.
7. Stage and activate a higher catalog config whose settings are exactly
   `{ platform: providerKey, stream: "catalog" }`; provider configuration sync
   must clear the config-scoped cursor.
8. Use a dedicated paused-origin resume guard, acquire the exact live utility
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
9. After the catalog run ends idle, submit and bind a second exact pause command.
   Keep the offline runtime paused and stage a still-higher event successor config
   while catalog remains active.
10. Synchronize the event successor, safely re-envelope the private saved cursor,
   restore it under the provider lock/CAS boundary, and activate central authority
   last.
11. Under a guarded paused-entry resume, acquire the exact live utility lease,
    resume and request the deterministic first successor event run using the
    restored cursor, then release the lease and launch the successor resident.
    Accept the run only when it starts from that cursor and reaches head.

Collector Crypt's immutable active config 3, authority, and saved cursor envelope
remain pinned to distributed adapter v1 during drain and preparation. The fresh
saved-cursor compatibility probe deliberately interprets the response with the
distributed-v2 successor that will consume the cursor. Its staged event successor
therefore re-envelopes both the configuration revision and adapter identity while
preserving the opaque cursor value. The live registry intentionally installs
Collector distributed v1, distributed v2, and catalog v2 during this transition.
Remove the v1 execution tuple only after the bridge has completed, central and
provider authority both reference the v2 successor, the restored v2 run has
reached head, and no active configuration, run, or saved cursor references v1.

The bridge-selected Collector Crypt catalog-v2 profile has an effective
100-record request ceiling. The one-shot applies the lower of the immutable
adapter limit and its runtime resource ceiling, so an operator artifact cannot
raise that bound. At the reviewed 191,452-record floor, a complete Collector
Crypt census therefore requires at least 1,915 sequential pages. Do not
substitute an ordinary 1,000-record event profile, the retained catalog-v1
reproducibility profile, or a raised catalog limit to reduce the page count.

The source head pins come from the read-only
`two_pass_read_only_catalog_census_v1` proof captured before drain. Both
null-origin passes must agree exactly on counts, traversal evidence, and the
identity-multiset digest. The proof binds one operation UUID plus the exact
checkout, commit, module hashes, authority, credential digest, and catalog
request bounds. It persists no raw source IDs, cursors, or response bodies. Two
agreeing passes establish a reproducible observed head, not a transactional
snapshot of a mutable upstream. Do not overlap this long-running census with
another manual source tool.

Preparation binds both the census file SHA-256 and canonical proof digest. The
catalog run must reproduce the pinned card and pack counts and identity multiset.
If cards or packs arrive, disappear, or repeat before that run, exact
raw/distinct/pin equality fails while the provider remains offline. Do not loosen
the evidence or edit the journal; create a new operation UUID and capture a new
census for it. Replaying a census into another operation refuses before database
or source work begins.

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
performs a read-only validation or writes mode-`0600` files into a mode-`0700`
private journal directory. It does not write to either database, call the
provider, unload a process, or start an import.

```bash
node --import tsx scripts/live/prepare-dataforrest-catalog-bridge.mts \
  --check-only \
  --input /absolute/private/catalog-bridge-input.json \
  --journal-directory /absolute/private/catalog-bridge-journal
```

Replace `--check-only` with `--prepare` only after the exact input was produced by
the reviewed census-bound live snapshot/canary reader. Preparation writes:

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

- a two-pass, read-only Collector Crypt source census before drain;
- a census-bound read-only snapshot/canary capture that creates the preparation
  input;
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

## Required rehearsal before live authorization

The dependency-injected rehearsal core exercises the real drain, catalog-stage,
and event-resume cores, but it always emits `non_certifying_hybrid`. Supplying it
production-shaped adapter claims cannot make it certify dependencies it does not
attest itself. It is not a standalone rehearsal executable or a
production-readiness certificate. Only a separate external attesting host binder
could verify the exact clean commit, migrated disposable central and provider
database clones over production-shaped remote-TLS routes, isolated macOS process
host or VM, and live DataForrest API and produce certification evidence. That
binder is not implemented here. Retain a reviewed evidence package that proves:

- every producer, `--check-only` command, journal transition, and successor-plist
  check uses the same exact commit and module digests;
- Collector Crypt requests never exceed 100 records and the full census completes
  within the derived refusal timeout without response-size or atomic-page failure;
- the catalog head contains the reviewed distinct card and pack counts with zero
  quarantine and unchanged event evidence;
- injected interruption leaves the resident offline and paused, and no page-K
  cursor, journal, config, or run identity can be reused; and
- event-cursor restoration, successor admission, launchd bootstrap, and final
  handoff complete from the reviewed paused boundary.

The current Collector Crypt recovery policy remains pinned to config 3 and cannot
materialize the strictly higher, fresh catalog configuration required after a
mid-census failure. The rehearsal must therefore report
`CATALOG_BRIDGE_REHEARSAL_FIXED_CONFIG_3_RETRY_UNSUPPORTED`. Until that blocker is
removed and the production-shaped evidence above is reviewed, live apply remains
unauthorized. A terminal one-shot failure still requires a new reviewed operation
and the fresh recovery sequence described above; the implemented artifact tools
do not turn it into a resumable run.

## Acceptance map

| Scenario | Coverage |
|---|---|
| Exact current config and clean resident are required | Automated: `dataforrest-catalog-bridge-plan.test.mjs` |
| Collector config 3/cursor stay v1 and re-envelope to the v2 successor | Automated: `dataforrest-catalog-bridge-plan.test.mjs` |
| Active work, lease, process, cursor, or canary drift refuses preparation | Automated: `dataforrest-catalog-bridge-plan.test.mjs` |
| Initial pause binds exact command and terminal-run/last-page provenance | Automated: `dataforrest-catalog-bridge-drain.test.mjs` |
| Bootout occurs only after paused/no-work/no-lease proof | Automated: `dataforrest-catalog-bridge-drain.test.mjs` |
| Idle-head queued-work race refuses while offline | Automated: `dataforrest-catalog-bridge-drain.test.mjs` |
| A pause-race reconciled head uses a distinct proof policy | Automated: both drain and plan tests |
| Catalog authority contains the explicit catalog stream | Automated: `dataforrest-catalog-bridge-plan.test.mjs` |
| Two sequential null-origin source passes must agree on counts and identity evidence without persisting raw IDs, cursors, or bodies | Automated: `dataforrest-catalog-bridge-source-census.test.mjs` |
| A census is single-operation-bound and refuses cross-operation replay before database or source work | Automated: source-census, plan, and operator-materialization tests |
| Preparation binds the census file, proof digest, counts, and identity-multiset digest | Automated: plan and operator-materialization tests |
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
| Per-provider full-census timeouts exactly match census-pinned counts and adapter bounds | Automated: execution-budget and catalog-live tests |
| Real cores reject reuse after injected interruption and preserve event data/cursor handoff | Automated hybrid: `dataforrest-catalog-bridge-rehearsal.test.mjs`; non-certifying |
| Fresh recovery requires a strictly higher config than the interrupted catalog config | Automated blocker: `CATALOG_BRIDGE_REHEARSAL_FIXED_CONFIG_3_RETRY_UNSUPPORTED` |
| End-to-end operator sequence against migrated disposable remote-TLS database clones, isolated macOS host/VM, and live API | Required production-shaped rehearsal evidence before live authorization; not asserted by repository tests |
