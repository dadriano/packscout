# Feature: Atomic Pack Publication in Pack Catalog V1

## Start Here

Authoritative continuation, September5 at21:03UTC: the user authorized foundation merges once current checks/review clear, then all remaining work, plus Admin/monitoring screenshots and an operating guide. PR121 and120 are merged; main remains `b96b43691b48170d64bdd541e4a42cb15f096ecf` including unrelated PR122. Preserve its chosen/reordered All Repacks columns and account preferences in011/007. Counts6/13 accepted,5/12 phases merged;003 is done,004/011 in progress. Remaining authorized merges:114 then119.

Final frozen runtimes196f897c/070f7d41 fix explicit session credentials and source frames with an equivalent linear source-name classifier. Complete148/121 tests0skip, affected static/ratchet, independent134 functional and14 equivalence checks pass. P03 full21903 PASSED with both builds; P04 full81058 is running. No source edit is pending. Root is publishing114 and its3941966281/3941966283 fixing-SHA replies; remote119 remains5cbb/draft with metadata3941816873 pending publication. Prior virtual-source reply3941954021 is resolved. No API, limit, phase or production activation change.

Capacity clarification requested18:33UTC, not yet answered: retain the existing1,000-pack/512-category catalog limit or support the proposed8,000-pack catalog with a more involved lossless query layout. Both preserve all frontend datapoints and8,000 full content members per pack. No capacity reduction or new architecture is approved pending the answer; foundation repairs continue independently.

The user-requested current-admin visual tour and management-guide index now exist at `output/pack-publication-current-admin-20260905/README.md`, with three fresh synthetic-source screenshots from main-equivalent 33cdfe96. They are explicitly not production or V1 publication evidence. P08 still owns the actual V1 guide and monitoring screenshot set; P10 adds exact-launch certification. Lower checkpoints are historical unless explicitly refreshed.

### Previous verification checkpoint

Current checkpoint (2026-09-05 11:15UTC): main remains `f678525141a55f4d7acbd82487a1871a94632096`. Task012 is done: full framework CI33960130659 passed exact PR120 headd0a45b2f/runtime77965267 at11:00:22UTC, with bot thumbs-up and resolved activation review; later616c6782 changes only delivery records. Task013 remains done/published PR121. Latest protected-account/direct-JSON repairs are published PR11419ecb8a9/runtime8dd10dbf and PR11956ade93a/runtime0bff3224. Root96 assembler/capacity/private-PG and67 profile/persistence/bundle tests pass, zero skips; static/ratchet pass and both114 P1 threads are replied/resolved. The P03 full local run failed when owned PostgreSQL exhausted host disk (257MiB free). No fresh local full pass is claimed; GitHub full CI must certify003/004. Previous passes do not certify these new runtimes. Subsequent metadata-only checkpoint commits may advance heads without source changes.

The user resolved the Bearer policy: do not reject the word or an opaque-looking following token alone. Protected fields and explicit authorization/credential assignments establish context; no word allowlist, length or digit heuristic. Current parallel ownership: p03_review delivered003's latest repair and independently cross-reviews root-owned004; p04_profiles watches the four PRs read-only in a bounded window.012's Save lifecycle fix is accepted. Benign-success controls remain intact; old Bearer-only negative fixtures require explicit Authorization context. Earlier policy-pause records are historical, not an active blocker.

The user requested `build-from-tasks all` and full coverage of every current frontend data point. This supersedes the earlier pause on later implementation. Heat stays excluded. No publisher, public head, public route, pruning, or launch has been activated.

P04 and P07A remain independent main siblings. P05B/task013 now owns the measured8-file/2,225-line neutral EV calculation/public-value extraction from011. It depends only on merged main and preserves formulas/current consumers. The two incomplete native economics files remain backed up for011. P05A resumes after003/004/005/013 merge: the read-only resume audit confirms004's not-yet-main profile assembler is also an actual dependency. Every frontend datapoint and complete-pack readiness remain required.

**Progress:**6/13 tasks acceptance-complete (001/002/003/005/012/013);5/12 phases merged.003 awaits fresh exact-head CI/review;004's full gate is running.011 waits for merged003/004/005/013 and resolution of capacity/query feasibility.006–010 remain todo. After011,006 publisher/recovery and007 frontend cutover can run in parallel;009 follows006 and008 follows006/007.010 is coordinated launch certification. Existing006/007 briefs define disjoint work. No live activation occurred.

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
- Pulls, sales activity, private provider-health causes, credentials, raw source evidence, and exact collectible instances inside a pack snapshot. Task011 preserves the existing sanitized public feed-status datapoint under the user's full-parity requirement.
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

**Merge order:** P01; P02, P04, and P05 independently; P03 follows P02; P05B and P07A follow merged P05 independently; P05A follows merged P03/P04/P05/P05B; P06 waits for P02–P05 and P05A; P07 waits for P05A/P07A; P08 waits for P06/P07; P09 waits for P06; P10 follows P08/P09. The user authorized remaining prerequisite merges114 then119 once current checks/review clear; production activation still requires the exact launch plan and evidence.

**Additional application path:** none. `pack_catalog_v1` is the only application contract and the frontend calls it directly.

**Deployment safety:** the release platform retains the pre-launch application artifact only through green launch smoke tests. Before any recurring V1 write, P10 makes V1 authoritative and removes that artifact from the launch rollback slot. This is infrastructure state, not another V1 read or publication path.

**Default review budget:** one reviewer thesis, one task, about 1–2 implementation days, at most two primary runtime surfaces, target no more than 2,500 authored changed lines and 25 authored files.

## Delivery Phases

| Phase | Reviewable outcome | Tasks | Requires | Planned PR relationship | Verification | Status |
|---|---|---|---|---|---|---|
| P01 | Executable V1 atomicity, identity, lifecycle, cursor, and error contracts | 001 | none | root on default | Two-pack V1 contract isolation | merged |
| P02 | Durable provider-local desired state, impact, readiness, and activation intent | 002 | P01 | root on main; PR95 | Provider-local crash and isolation matrix | merged |
| P03 | Deterministic complete pack snapshot assembly | 003 | P02 | main; PR114 | Final148/full pass; fresh exact-head CI/review pending | published |
| P04 | Durable shared-change fan-out and independent profiles | 004 | P01 | main; PR119 | Final121 focused pass; fresh full gate running | building |
| P05 | Authenticated immutable public storage and the sole V1 read API | 005 | P01 | sibling from P01 | Store, CAS, and six-journey API contract | merged |
| P05B | One neutral existing EV calculation and public-value core | 013 | P01, P05 | merged PR121 | Exact parity/full gate; merge0ea61454 | merged |
| P05A | Preserve every current frontend data point in native V1 | 011 | P03, P04, P05, P05B | root after prerequisites merge | Source-to-snapshot-to-frontend data parity | building |
| P06 | Idempotent pack/profile publication and fenced per-pack recovery | 006 | P02–P05, P05A | root after prerequisites merge | Publication ambiguity and recovery race | planned |
| P07A | Native six-operation loaders and authoritative saved-item state | 012 | P05 | PR120 mergedf852a166 | Auth-refresh repair certified:654 frontend tests, full local and CI33974274282 pass | merged |
| P07 | Direct V1 frontend across every catalog journey | 007 | P05, P05A, P07A | atomic switch after full data parity | Full frontend data parity and browser proof | planned |
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
- **Size exception:** Boundary review permits approximately 28 authored files and 3,250 authored changed lines after the P05 rebase. The boundary/recovery test modules certify inseparable admission-to-outbox, time-dependent readiness, and crash/expiry invariants while keeping the existing 470-line crash suite within the file-size limit. Separating these regressions from the persistence fixes would leave the transaction boundary uncertified. Runtime scope remains the same dormant provider state machine; no generated files are added. This remains below the 40-file/5,000-line hard stop; remeasure before publication.
- **Branch:** `codex/pack-version-publication-p02-state`.
- **Direct base:** `main`; prerequisite https://github.com/dadriano/packscout/pull/96 is merged after a green full CI gate.
- **Verified direct parent:** `8125934bb39338f73501ac1bc9fef8950d462746` (PR113). Backup `codex/p02-before-watchlist113-20260904` retains b71ec45b; old P03 boundary8409143c is preserved.
- **Implementation:** `b5482a96570f71de46d2c87d849e2b3e11bcce2c`; task acceptance and full corrected-head local/CI gates pass.
- **Evidence:** 118 focused checks, 30 schema checks, 13 signed public-store tests, affected lint/types/docs, and the zero-finding ratchet pass. Capacity log: `/tmp/packscout-p02-lifecycle-capacity-focused-20260904.log`; signed store log: `/tmp/packscout-p02-public-store-results-convex-20260904.log`.
- **Merged:** `631b9f38badf3233cf470d2108ff3ebdbb988d9f`, 2026-09-04 16:32 UTC, tree-identical to certified bd5f3c64. Full local/CI gates passed; all 35 reviews resolved. P06 owns transport/worker E2E.
- **Integration handoff:** P06 binds transaction-local input capture and authenticated transport; P04 resumes incomplete impact results and sends shared deliveries in increasing provider sequence. See task 002's spec-compliance notes.
- **PR:** https://github.com/dadriano/packscout/pull/95

#### P03 — Deterministic assembler

- **After merge:** A pure assembler produces or rejects one complete snapshot deterministically; it does not publish.
- **Review budget:** one task; 1–2 days; target at most 18 authored files and 2,000 authored lines.
- **Rollback:** Revert the unused assembler and fixtures.
- **Measured boundary:** Final linear-source runtime and delivery records:18 authored files /3,169 changed lines against main `b96b4369`:11 runtime/test files /2,812 lines and7 delivery records /357 lines. The soft target is exceeded by cohesive assembly, privacy and evidence tests, not only metadata. The phase remains below the40-file/5,000-line hard stop. No generated churn.
- **Branch:** `codex/pack-version-publication-p03-assembler`.
- **Current parent:** main `b96b43691b48170d64bdd541e4a42cb15f096ecf`. Earlier parents and backups remain preserved.
- **Current implementation:** Runtime `196f897c230f789de17c4948101600f9c9bcd954` repairs session/.NET comments3941966281/3941966283, includes independently verified Ruby/Go/PHP frames and removes quadratic source-name retry without changing policy.
- **Current verification:**148 complete focused tests, zero skips, affected static/ratchet, independent134 functional and14 equivalence checks pass. Full local verifier PASSED with both builds;003 is done. Fresh exact-head CI and review still gate merge;28 unrelated full-run opt-in skips remain disclosed.
- **PR:** https://github.com/dadriano/packscout/pull/114 — open, non-draft, not merged. The user authorized merging once exact-head checks pass and review findings are clear; no renewed approval is needed for this prerequisite.

#### P04 — Shared fan-out and profiles

- **After merge:** Central changes and profile intents are durable per provider, including while a provider is unavailable; workers remain disabled.
- **Review budget:** one task; 1.5–2 days; target at most 20 authored files and 2,200 authored lines.
- **Rollback:** Stop disabled workers and retain unclaimed durable evidence.
- **Boundary review:** At published head `5cbb7b13`, 30 authored files / 3,421 changed lines: 23 runtime/test/migration files / 3,231 lines and 7 delivery records / 190 lines. Transaction, immutability, profile assembly, privacy and crash/isolation tests form one dormant persistence boundary. The soft target overage is not metadata-only; splitting those proofs from their state would leave the boundary uncertified. Remeasure after the literal-stack repair; retain the 40-file / 5,000-line hard stop. No generated churn.
- **Branch:** `codex/pack-version-publication-p04-profiles`.
- **Current direct parent:** main `b96b43691b48170d64bdd541e4a42cb15f096ecf`; local final runtime `070f7d41`, remote head still `5cbb7b13`. Restack after the authorized PR114 merge, preserving both service exports and current main.
- **Current verification:**121 complete focused tests, zero skips, affected lint/types and ratchet pass;85 pure and316 retained guard probes pass. Metadata privacy rejects20 hostile cases with no change to seven publication tables. Independent134 functional/14 equivalence review is clear. Fresh full gate is running; old CI `33986807092` certifies5cbb only.
- **Current repair:** Shared metadata/session validation and explicit standard/virtual source-frame protection, including final derived casefolded text and equivalent linear source classification. No dependency, formula or runtime activation change.
- **PR:** https://github.com/dadriano/packscout/pull/119 — draft, pending repaired-runtime full CI; phase remains building.

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
- **Merged:** `27c7f7ec894996747095aa97652cd95aaefdc4e3` on 2026-09-04 at 11:54:05 UTC. The P05 owner's task record retains its focused evidence and inherited full-gate failures; the merge is not certification of P02 or current main.

#### P05A — Complete frontend data contract

- **User requirement:** Preserve all data points currently used by the frontend, confirmed on 2026-09-04.
- **Owned task:** 011; supplements the original reduced contract without renumbering existing tasks.
- **After merge:** Native V1 snapshots and reads preserve all current public data; candidate frontend and recurring publication remain unexposed.
- **Review budget:** One data-completeness thesis; measure against 25 files/2,500 lines, split at a safe boundary if necessary; no size exception recorded.
- **Branch:** `codex/pack-version-publication-p05a-frontend-data`; saved head `44e2f193`, currently no worktree or PR. Immutable stash `961f20694651e80c2e665f555bbce1e347dcc143` preserves all ten partial files. Eight neutral-core files are already merged through013; do not restore them again. Only the two incomplete native economics files remain to reconsider. Recreate from merged003/004/005/013 and resolve the recorded catalog-capacity choice before query-layout implementation.
- **Verification:** Field inventory, source-to-snapshot parity, per-pack isolation, lifecycle/rollback, every public journey and saved identity, and full framework gate.

#### P05B — Neutral existing EV core

- **Owns:**013, split from011 at the measured8-file/2,225-line domain boundary; two incomplete native economics files stay with011.
- **After merge:** Existing consumers and native replay share exact calculator/confidence functions and public values; no source capture, API, active head, writer or route changes.
- **Verified direct base:** main `f678525141a55f4d7acbd82487a1871a94632096`; independent of PR114/119/120.
- **Branch/worktree:** `codex/pack-version-publication-p05b-ev-core` / `.worktrees/pack-version-publication-p05b-ev-core`; reuse the idle P05A directory/dependencies only after complete immutable preservation.
- **Review budget:**8 source/test files/2,225 measured changed lines, mostly exact moves. The16 requested task records may take the total past2,500lines; target overage must be metadata-only and below40files/5,000lines. Splitting calculation from parity proofs or leaving duplicate formulas is unsafe. Remeasure before publish; no generated/lockfile churn intended.
- **Verification:**013 exact identity/replay, full predecessor regressions, affected lint/types/boundaries/ratchet and framework gate.011/006/007 retain data/runtime/browser E2E.
- **Rollback:** Revert the pure extraction; current application behavior and stored data remain unchanged.
- **Implementation:** Runtime `77c01707`; certified head `14c64485` is tree-identical to the squash merge. Root364/364 focused regressions, exact-body comparison, affected static checks and full local framework gate pass; full CI `33945214745` passes with bot thumbs-up. The full runner's28 unrelated opt-in skips are disclosed in013, not represented as zero skips.
- **PR:** https://github.com/dadriano/packscout/pull/121 — merged September5 at15:00:24UTC, squash `0ea6145470a276807a0e9590d759d9fad85e9226`. Task013 is done and phaseP05B merged. No production activation occurred.

#### P06 — Publisher and recovery

P05B/task013 is a separate prerequisite of P05A, not extra publisher scope.

- **After merge:** Disabled workers can be exercised end to end, and protected commands safely recover one pack through the same fences and receipts.
- **Review budget:** one task; 2–3 days; target at most 25 authored files and 2,500 authored lines.
- **Rollback:** Disable workers and commands; active heads remain readable and unchanged.
- **Size exception:** Publication and recovery are one concurrency boundary and must verify the same epoch, hold, and receipt state; separating them would merge an unsafe partial control plane. Authored volume remains capped at the default threshold.
- **Branch:** assigned by builder.
- **Verified parent:** not recorded.
- **Verified implementation:** not recorded.
- **PR:** not opened.

#### P07A — Native frontend foundation

- **Owns:** task012, split from007 using the measured14-file/1,067-line source-only diff. No visible catalog route switches here.
- **Branch:** `codex/pack-version-publication-p07a-frontend-foundation`; worktree remains `.worktrees/pack-version-publication-p07-frontend`.
- **Final implementation:** Runtime `3d134eb0a17cd6cfc6aff4825b68f559d32e7942`, certified head `33cdfe962b8bd45672b5fef1b151bf4afb23525e`. Same-user auth refresh preserves pending saves while new writes remain disabled during loading; terminal identity changes and unmount dispose the old owner state. All654 frontend tests,112 focused checks including64 ReactDOM cases, full local gate and CI `33974274282` pass. Mocked transport is not a real Privy session claim.
- **Review promise:** exactly six native dormant loaders plus current native saved-state reconciliation. No alternate catalog journey, DTO adapter, or production flag.
- **Boundary review:** 29 authored files / approximately 1,726 changed lines, including 14 frontend files / 1,099 lines and 15 canonical task/handoff records / 627 lines. The file target is exceeded only by task tracking. The measured frontend foundation is already split from the atomic visible switch; further fragmentation would separate saved-state behavior from its presentation/security tests. No generated churn; remeasure after verification.
- **PR:** https://github.com/dadriano/packscout/pull/120 — merged September5 at15:59:36UTC, squash `f852a166cca88008eb2eb419a6a555c7ff794597`, tree-identical to certified `33cdfe96`. Bot review clear; auth-refresh comment `3940423155` replied in `3941053968` and resolved. Task012 is done and phaseP07A merged. Visible catalog routes remain unchanged.
- **Later owner:**007 atomically switches every visible consumer after011 full data support; no temporary mixed list/detail snapshots.

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
| 003 | Assemble complete deterministic pack snapshots | P03 | medium | 1–2 days | done | 002 |
| 004 | Persist shared profile publication and fan-out | P04 | medium | 1.5–2 days | in_progress | 001 |
| 005 | Store and serve Pack Catalog V1 | P05 | large | 2–3 days | done | 001 |

### Integration and launch tasks

| ID | Task | Phase | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|---|
| 011 | Preserve every frontend data point in V1 | P05A | large | scope from field inventory | in_progress | 003, 004, 005, 013 |
| 013 | Share neutral existing EV calculation core | P05B | medium | measured extraction | done | 001, 005 |
| 012 | Native frontend loaders and authoritative saves | P07A | medium | scoped foundation | done | 005 |
| 006 | Publish and recover pack state | P06 | large | 2–3 days | todo | 002, 003, 004, 005, 011 |
| 007 | Render Pack Catalog V1 in the frontend | P07 | medium | field-driven scope | todo | 005, 011, 012 |
| 008 | Operate and observe pack publication | P08 | medium | 1.5–2 days | todo | 006, 007 |
| 009 | Retain and prune pack and profile snapshots | P09 | medium | 1 day | todo | 006 |
| 010 | Launch and certify Pack Catalog V1 | P10 | medium | 4–8 hours | todo | 008, 009 |

Total estimated builder/operator effort is 14–21 working days if serialized. P02–P05 and later P07/P09 reduce elapsed time when staffed in parallel.

## Build Order and PR Topology

1. Keep merged P01/PR88, P02/PR95, and P05/PR108 accepted; do not rebuild them.
2. Merge P03/PR114 after exact-head CI/review clear on current mainb96b4369; preserve independent phase scope.
3. Publish and merge P04/task004 after its fresh gate, review and post114 restack. P07A/task012 and P05B/task013 are already merged. Original P05A branch44e2f193 and complete ten-file stash961f2069 remain preserved.
4. Resume P05A/task011 from merged003/004/005/013 prerequisites and the capacity choice, restoring only its incomplete economics/data work. P06 requires P02–P05 plus011; atomic P07 requires005/011/012. Every frontend datapoint remains in scope.
5. Build P08 after P06/P07 and P09 after P06. P10 operates only on the exact certified merged release.

| Phase | Direct prerequisite | Current relationship |
|---|---|---|
| P03 | merged P02 | PR114 on main |
| P04 | merged P01 | independent main sibling |
| P05B | merged P01/P05 | independent mainf6785251 sibling; neutral unchanged EV core |
| P05A | merged P03/P04/P05/P05B | original44e2f193 plus ten-file stash961f2069 preserved; recreate from merged prerequisites |
| P07A | merged P05 | independent main sibling; dormant native loaders and current saves |
| P06 | P02–P05 and P05A | integration after prerequisite merges |
| P07 | P05, P05A, P07A | atomic visible consumer switch, not operation-by-operation coexistence |
| P08 | P06, P07 | operations/readiness |
| P09 | P06 | retention sibling |
| P10 | P08, P09 | exact-release operation, no implementation PR |

Cap dependent open stack depth at three; ordinary prerequisite review waiting is not task completion or approval. Do not merge a child into an open parent branch. No build verification by itself changes production routing or publication authority.

## Next Action

Use the granted conditional merge authority.121 has merged; repair114's prose-prefixed JSON and120's pending auth-refresh settlement, propagate004, restack on current main, verify and merge the remaining approved foundations only when checks/reviews are clear. Resume011 after merged003/004/005/013, then006/007 in parallel. P08 includes a real Admin/monitoring screenshot set and `docs/pack-catalog-v1-operations.md`. Preserve all frontend datapoints, whole-pack coherence, existing authority checks and exact P10 launch gates. Do not re-ask the resolved Bearer policy or infer a production gate bypass.
