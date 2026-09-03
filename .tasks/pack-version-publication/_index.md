# Feature: Atomic Pack Publication in Pack Catalog V1

## Start Here

Review P02's provider-local persistence PR, then build task 003 / P03, the deterministic snapshot assembler. No publication processor is enabled.

**Progress:** 2/10 tasks complete; 2/9 implementation phases merged; P05 merged in PR108; P02 certification pending; 0/1 launch operations complete

## Context

Packscout needs one public catalog whose unit of consistency is a single pack. A pack must never expose metadata from one update with contents, odds, chase, valuations, or EV from another. Work for one pack or provider must not delay otherwise-ready packs.

`pack_catalog_v1` is the first and only public pack contract in this plan. The API and frontend consume it directly. Immutable pack snapshots are domain records within V1, not later API schemas.

Provider databases remain isolated and authoritative for provider-owned history. A bounded public projection serves complete pack snapshots and independently published provider and collectible profiles. PR #66 is not merged as a unit; only primitives that satisfy this V1 contract may be carried into these review-sized phases.

## Success Signals

### Integrity and isolation

- Updating pack A changes only pack A's immutable snapshot and atomic head; pack B remains byte-identical.
- Every visible pack resolves metadata, lifecycle, full contents, probabilities, chase, valuations, EV, and actions from one complete snapshot.
- An unavailable provider or blocked pack never prevents ready packs from other providers from publishing or being read.
- Stable pack and collectible identities survive snapshot updates, rollback, lifecycle changes, saves, and deep links.
- Public reads stay available while ingestion or publication workers are paused.

### Timeliness and operation

- A healthy ready change reaches its active pack head within 15 minutes.
- The oldest pending item alerts after 30 minutes with a stable reason and affected pack identity.
- Automatic retry resolves transient failures without creating duplicate snapshots, intents, or head advances.
- Authorized operators can inspect status and recover one pack without gaining browser-accessible publication authority.
- Initial launch proves complete active-head coverage for every ready included pack and two independent post-resume pack activations.

## Resolved Decisions

### Atomic product model

- One immutable `PublicPackSnapshot` is the complete rendering and calculation boundary for one pack in `pack_catalog_v1`.
- One `ActivePackHead` atomically selects the active snapshot for one stable pack identity and retains the previous eligible snapshot for recovery.
- A pack snapshot contains metadata, lifecycle, full contents, probabilities, pack-specific actions, chase result, collectible/category display data, valuations, EV inputs, EV result, and EV policy evidence.
- `PublicProviderProfile` contains stable provider identity, display name, brand assets, and provider-wide promotion copy/actions; `PublicCollectibleProfile` contains stable collectible identity, display name, image, category, aliases/search text, and current valuation display evidence. Each publishes independently.
- Heat is not part of V1 data, queries, filters, presentation, calculations, or operations.

### Ordering and shared changes

- Each provider database owns a provider-local monotonic pack-publication sequence and durable desired-state request before assembly begins.
- Artifact creation and publication intent creation are crash-safe; identical snapshot bytes may reuse an artifact, but every activation attempt has its own intent and receipt.
- Central shared changes create one durable shard per in-scope provider before advancing their checkpoint.
- Each provider expands its shard into exact affected packs locally, so an unavailable provider loses no work and blocks no other provider.
- A pack's first activation waits for required provider and referenced collectible profile heads; later profile updates publish independently.

### Completeness and calculations

- Full contents are required. Partial contents, invalid probabilities, mismatched inputs, incomplete protected fields, or technical EV failures cannot publish.
- A valid domain result with no calculable EV publishes as `unavailable`; a transient technical calculation failure waits and retries, while permanently invalid input blocks with a stable reason.
- Top chase is the highest-valued eligible collectible under the sealed policy, and every eligible member's valuation participates in the dependency digest.
- Lifecycle-only snapshots may change lifecycle, actions, provenance, and derived presentation evidence, but cannot silently change numeric economics.
- EV method and policy evidence is sealed into every snapshot; a formula change requires a separately approved V1 task set.

### Public behavior

- Default browse and search show only packs whose retirement state is active and whose availability is available; an explicit all-state view, saves, and direct links expose sold-out, unavailable, unknown, and retired packs.
- Purchase and promotion actions are enabled only when a pack is active and available; complete last-known contents remain readable otherwise.
- Shell status, dashboard, pack list, pack detail, collectible search, and desired-collectible lookup all use the sole V1 contract; saves and direct links are cross-cutting stable-identity checks.
- Pagination is live keyset pagination: each response is coherent, but later pages may reflect unrelated pack-head advances.
- Native signed cursors fail with bounded `CURSOR_EXPIRED` behavior when expired, malformed, tampered, or inconsistent with the query.

### Recovery, retention, and launch

- Transient work retries automatically; permanent invalid input blocks with a stable reason; ambiguous network results reconcile by receipt before retry.
- Pack recovery fences writers first, then retries, selects a retained prior snapshot, or resumes through out-of-band commands requiring the admin-only `pack_publication:recover` permission.
- Admin is read-only and default-off. Both `admin` and `data_operator` roles may view sanitized organization-scoped status through `providers:view`; no publication action exists in Admin.
- Completed pack, provider-profile, and collectible-profile snapshots remain retained for at least 30 days from deactivation when formerly active or from durable terminal completion when never active; production pruning requires the admin-only `pack_catalog:prune` permission and in-flight or recovery roots remain until terminal.
- Launch uses the exact certified application commit, an admin holding `pack_catalog:launch`, a trusted deployment identity, and an infrastructure-level blue/green route. The pre-launch application release is held only as the bounded deployment rollback target, cannot be called by V1 code, and receives no V1 publication writes.

## Out of Scope

### Product data

- Heat scoring, presentation, filters, calculations, and operating controls.
- Pulls, sales activity, provider health, credentials, source evidence, and exact collectible instances inside a pack snapshot.
- User-visible partial packs, estimated contents, or cross-pack transactional releases.
- Provider-specific behavior inside generic publication or public-read contracts.
- A second public catalog schema or alternate frontend data contract.

### Operations

- Write controls in Admin.
- Publishing one whole provider or the whole platform as a consistency unit.
- Continuing publication when required source truth is incomplete or technically inconsistent.
- Automatic retirement caused by omission, outage, or age; retirement requires explicit persisted provider evidence.
- Destructive production data operations outside a separately authorized task.

### Notifications

- Publication-delay alerts persist in the existing Admin alerts area only.
- Email, webhook, push, or other external publication-alert delivery.

## Delivery Strategy

**Mode:** mixed parallel foundations with a short integration stack

**Activation phase:** P10 launches the exact V1 release certified by P08 and protected by P09.

**Merge order:** P01; P02–P05 may proceed in parallel; P06 waits for P02–P05; P07 may stack on P05; P08 waits for P06/P07; P09 waits for P06; P10 follows P08/P09.

**Additional application path:** none. `pack_catalog_v1` is the only application contract and the frontend calls it directly.

**Deployment safety:** the release platform retains the pre-launch application artifact only through green launch smoke tests. Before any recurring V1 write, P10 makes V1 authoritative and removes that artifact from the launch rollback slot. This is infrastructure state, not another V1 read or publication path.

**Default review budget:** one reviewer thesis, one task, about 1–2 implementation days, at most two primary runtime surfaces, target no more than 2,500 authored changed lines and 25 authored files.

## Delivery Phases

| Phase | Reviewable outcome | Tasks | Requires | Planned PR relationship | Verification | Status |
|---|---|---|---|---|---|---|
| P01 | Executable V1 atomicity, identity, lifecycle, cursor, and error contracts | 001 | none | root on default | Two-pack V1 contract isolation | merged |
| P02 | Durable provider-local desired state, impact, readiness, and activation intent | 002 | P01 | sibling from P01 | Provider-local crash and isolation matrix | building |
| P03 | Deterministic complete pack snapshot assembly | 003 | P01 | sibling from P01 | Complete deterministic assembly | planned |
| P04 | Durable shared-change fan-out and independent profiles | 004 | P01 | sibling from P01 | Offline-provider fan-out and profile matrix | planned |
| P05 | Authenticated immutable public storage and the sole V1 read API | 005 | P01 | sibling from P01 | Store, CAS, and six-journey API contract | in review |
| P06 | Idempotent pack/profile publication and fenced per-pack recovery | 006 | P02–P05 | root after prerequisites merge | Publication ambiguity and recovery race | planned |
| P07 | Direct V1 frontend across every catalog journey | 007 | P05 | stacked on P05 | Six-journey browser acceptance | planned |
| P08 | Bounded monitoring, read-only Admin, alerts, and launch-plan/readiness evaluation | 008 | P06, P07 | root after prerequisites merge | Operational readiness and fault drill | planned |
| P09 | Root-safe snapshot retention and bounded pruning | 009 | P06 | sibling from P06 | Retention and active-head race | planned |
| P10 | Exact certified V1 release publicly launched or safely aborted | 010 | P08, P09 | operational; no PR; exact merged commit | First Pack Catalog V1 launch | planned |

### Phase Details

#### P01 — V1 contract

- **After merge:** Browser-safe contracts and fixtures define the only allowed pack/profile/read behavior; no runtime changes.
- **Review budget:** one task; 1–2 days; target at most 15 authored files and 1,500 authored lines.
- **Rollback:** Revert unused contract additions and fixtures.
- **Size exception:** One-time P01 exception: the pre-existing 2,619-line canonical task/spec baseline plus the inseparable executable contract, fixture, and matrix; two inherited test-only gate defects are isolated in a separate cleanup commit. The measured total is 4,998 authored changed lines across 29 files, below the 5,000-line/40-file hard stop.
- **Branch:** `codex/pack-version-publication-p01-contract`.
- **Verified parent:** `3c854bba5031b071421e3257edce172836e3f5bd` (`origin/main`, includes merged PR #85).
- **Verified implementation:** `2ca1c7ba` (review fixes in `20f19a56`).
- **PR:** https://github.com/dadriano/packscout/pull/88
- **Merged:** `c66f8666229455fd95d7dca58d3d85a391c01f21` on 2026-09-03.

#### P02 — Provider-local publication state

- **After merge:** Every provider database can durably plan affected packs and record ready or blocked desired state; no publisher is enabled.
- **Review budget:** one task; 2–3 days; target at most 25 authored files and 2,500 authored lines.
- **Rollback:** Leave new state unused and revert the disabled planner.
- **Size exception:** The provider-local schema, impact plan, readiness decision, sequence allocation, and durable request form one transaction boundary; splitting them would leave an incomplete provider authority. Authored volume remains capped at the default threshold.
- **Branch:** `codex/pack-version-publication-p02-state`.
- **Verified parent:** `0d73ff3970aa2c8e4dec9dd4905caf6380997567` (includes merged P01 and independent frontend PR94).
- **Verified implementation:** `0727718d6fde3e0da94382796b11a7d2c81da4de`; unchanged patches from the passing full framework gate, with framework/ratchet/typecheck/frontend/build checks repeated after rebase.
- **Integration handoff:** P06 binds transaction-local input capture and authenticated transport; P04 resumes incomplete impact results and sends shared deliveries in increasing provider sequence. See task 002's spec-compliance notes.
- **PR:** not opened.

#### P03 — Deterministic assembler

- **After merge:** A pure assembler produces or rejects one complete snapshot deterministically; it does not publish.
- **Review budget:** one task; 1–2 days; target at most 18 authored files and 2,000 authored lines.
- **Rollback:** Revert the unused assembler and fixtures.
- **Size exception:** none.
- **Branch:** assigned by builder.
- **Verified parent:** not recorded.
- **Verified implementation:** not recorded.
- **PR:** not opened.

#### P04 — Shared fan-out and profiles

- **After merge:** Central changes and profile intents are durable per provider, including while a provider is unavailable; workers remain disabled.
- **Review budget:** one task; 1.5–2 days; target at most 20 authored files and 2,200 authored lines.
- **Rollback:** Stop disabled workers and retain unclaimed durable evidence.
- **Size exception:** none.
- **Branch:** assigned by builder.
- **Verified parent:** not recorded.
- **Verified implementation:** not recorded.
- **PR:** not opened.

#### P05 — Public store and V1 reads

- **After merge:** Authenticated staging, finalization, heads, holds, and the sole V1 API are complete but not publicly routed.
- **Review budget:** one task; 2–3 days; target at most 25 authored files and 2,500 authored lines.
- **Rollback:** Keep public routing absent and revert unused store/read code.
- **Size exception:** The store and read API share one schema-bound integrity thesis; separating them would permit unverified public shapes to diverge from stored snapshot evidence. Delivered at 36 authored code files and 5,396 added lines (about 1,680 in tests and test support), over the 25-file / 2,500-line target and slightly over the 5,000-line figure P01 cited as its hard stop; the protocol contract, store, read API, and their boundary tests form one review thesis.
- **Branch:** `codex/pack-version-publication-p05-store`.
- **Verified parent:** `86e2a142` (`origin/main`, including merged #96 and #105).
- **Verified implementation:** `cba917ab`; review fixes `af924572`, `a995f62d`, and `7b319840`.
- **Contract correction:** pack search text is title plus aliases; the measured P01 fixture exceeds its 1,024-character bound at 50 contents and the Convex document bound at 8,000. P03's assembler adopts the rule at rebase. See task 005.
- **PR:** https://github.com/dadriano/packscout/pull/108

#### P06 — Publisher and recovery

- **After merge:** Disabled workers can be exercised end to end, and protected commands safely recover one pack through the same fences and receipts.
- **Review budget:** one task; 2–3 days; target at most 25 authored files and 2,500 authored lines.
- **Rollback:** Disable workers and commands; active heads remain readable and unchanged.
- **Size exception:** Publication and recovery are one concurrency boundary and must verify the same epoch, hold, and receipt state; separating them would merge an unsafe partial control plane. Authored volume remains capped at the default threshold.
- **Branch:** assigned by builder.
- **Verified parent:** not recorded.
- **Verified implementation:** not recorded.
- **PR:** not opened.

#### P07 — V1 frontend

- **After merge:** The complete frontend directly renders V1 through non-public release verification; production routing remains unchanged.
- **Review budget:** one task; 1–2 days; target at most 22 authored files and 2,200 authored lines.
- **Rollback:** Keep the candidate application release unexposed and revert direct integration changes.
- **Size exception:** none.
- **Branch:** assigned by builder.
- **Verified parent:** not recorded.
- **Verified implementation:** not recorded.
- **PR:** not opened.

#### P08 — Operational readiness

- **After merge:** Authorized teams can inspect sanitized state, dry-run alerts, approve an exact pre-seed launch plan, and evaluate post-seed readiness; production seeding remains a P10 operation.
- **Review budget:** one task; 1.5–2 days; target at most 25 authored files and 2,500 authored lines.
- **Rollback:** Keep routes, schedules, alerts, and recurring workers disabled; active heads remain readable.
- **Size exception:** none; Admin and operations consume one read-only status and readiness contract.
- **Branch:** assigned by builder.
- **Verified parent:** not recorded.
- **Verified implementation:** not recorded.
- **PR:** not opened.

#### P09 — Retention safeguards

- **After merge:** Retention roots and dry-run pruning are complete; production deletion remains disabled pending P10 authorization.
- **Review budget:** one task; 1 day; target at most 15 authored files and 1,500 authored lines.
- **Rollback:** Disable pruning; immutable snapshots and heads remain intact.
- **Size exception:** none.
- **Branch:** assigned by builder.
- **Verified parent:** not recorded.
- **Verified implementation:** not recorded.
- **PR:** not opened.

#### P10 — V1 launch

- **After operation:** Production is either serving the exact certified V1 release with normal workers enabled or the attempt is recorded as aborted with publication and pruning disabled.
- **Review budget:** one operation; 4–8 hours; no authored code or generated output.
- **Rollback:** Abort before exposure or use the authorized deployment-release boundary after exposure; do not change pack heads during application rollback.
- **Size exception:** none.
- **Branch:** none; run against the exact merged and certified commit.
- **Verified parent:** not recorded.
- **Verified implementation:** not recorded.
- **PR:** not applicable.

## Tasks

### Foundation tasks

| ID | Task | Phase | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|---|
| 001 | Establish the Pack Catalog V1 contract | P01 | medium | 1–2 days | done | none |
| 002 | Persist provider-local pack publication state | P02 | medium | 2–3 days | done | 001 |
| 003 | Assemble complete deterministic pack snapshots | P03 | medium | 1–2 days | todo | 001 |
| 004 | Persist shared profile publication and fan-out | P04 | medium | 1.5–2 days | todo | 001 |
| 005 | Store and serve Pack Catalog V1 | P05 | large | 2–3 days | done | 001 |

### Integration and launch tasks

| ID | Task | Phase | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|---|
| 006 | Publish and recover pack state | P06 | large | 2–3 days | todo | 002, 003, 004, 005 |
| 007 | Render Pack Catalog V1 in the frontend | P07 | medium | 1–2 days | todo | 005 |
| 008 | Operate and observe pack publication | P08 | medium | 1.5–2 days | todo | 006, 007 |
| 009 | Retain and prune pack and profile snapshots | P09 | medium | 1 day | todo | 006 |
| 010 | Launch and certify Pack Catalog V1 | P10 | medium | 4–8 hours | todo | 008, 009 |

Total estimated builder/operator effort is 14–21 working days if serialized. P02–P05 and later P07/P09 reduce elapsed time when staffed in parallel.

## Build Order

1. Merge P01 and its executable V1 contract fixtures.
2. Build P02, P03, P04, and P05 as parallel sibling PRs from P01.
3. Build P06 after P02–P05 merge; build P07 as soon as P05 is reviewable.
4. Build P08 after P06/P07 and P09 after P06.
5. Execute P10 only against the exact commit certified by P08 and protected by P09.

## Parallel Groups

| Group | Ready when | Tasks |
|---|---|---|
| A | immediately | 001 |
| B | 001 complete | 002, 003, 004, 005 |
| C | 002–005 complete for 006; 005 complete for 007 | 006, 007 |
| D | 006/007 complete for 008; 006 complete for 009 | 008, 009 |
| E | 008 and 009 complete | 010 |

## PR Topology

```text
P01 contract
 ├── P02 provider-local state ─┐
 ├── P03 assembler ────────────┤
 ├── P04 shared profiles ──────┼── P06 publisher/recovery ──┬── P08 operations/readiness ─┐
 └── P05 public store/API ─────┘                             └── P09 retention ────────────┼── P10 launch
            └── P07 frontend ────────────────────────────────────────> P08 ────────────────┘
```

P02–P05 may merge in any order after P01. P06 branches from updated default after all four merge. P07 may stack on P05 and rebase after P05 merges. P08 waits for P06/P07; P09 may proceed independently after P06. P10 is an operation, not an implementation PR.

## Next Action

Publish the verified P02 branch for review. Next implementation is task 003 / P03; P03–P05 remain planned foundation phases and publication stays disabled until P06 and launch authorization.
