# Feature: PostgreSQL to Convex Provider Releases and Catalog Manifests

## Start Here

Open `postgres-convex-promotion/007` and define the provider-impact outcome for one platform-specific cause, one cross-platform cause, and one manifest-lifecycle cause before changing any release or publication contract.

**Progress:** 8/14 tasks complete

## Context

PostgreSQL remains PackScout's only canonical catalog authority. Convex serves sanitized immutable public data, but the completed implementation packages every provider into one global release gated by one organization-wide catalog watermark. That makes unrelated provider delays block publication and couples every provider to one release cadence.

The approved architecture gives each configured platform its own immutable provider releases. Provider releases complete independently and remain invisible until one small immutable global manifest selects exactly one release for every enabled platform. One compare-and-swap active-manifest pointer exposes the whole provider set atomically. The public read model composes that set into the existing public V2 DTOs; no provider-release detail enters public responses.

Tasks `001`–`006` remain completed historical foundations. Their causal ledger, deterministic projection, authenticated replay, worker recovery, normalized Heat observations, and fail-closed Heat behavior are regression inputs. The single global assembler, release pointer, catalog lane, and Heat release binding in `002`, `003`, `004`, and `006` are superseded by tasks `007`–`013`. The former certification task has been replaced by final task `014` so there is one readiness gate.

## Resolved Decisions

### Ownership and causality

- A "provider release" is owned by one configured platform identified by stable `platformKey`; provider database IDs and caller-supplied selectors never define public ownership.
- PostgreSQL stays canonical. Promotion reads settled canonical state and publishes immutable batches; ingestion never dual-writes rows to Convex.
- Catalog settlement is provider-impact aware. A provider-specific technical failure blocks only that provider's catalog checkpoint.
- The organization-global contiguous checkpoint remains authoritative for Heat and audit ordering; it is not the gate for every provider release.
- Cross-provider causes carry the exact affected platform set, and manifest lifecycle/configuration causes have explicit settled eligibility.

### Configuration and release reuse

- One approved public-configuration revision defines a shared immutable configuration epoch. Every provider release in one manifest must use that epoch.
- A new configuration epoch is an all-enabled-provider barrier; no old-epoch provider release is reused in the new epoch.
- Within one epoch, unchanged provider content reuses the existing complete provider release. Observation time and freshness do not enter its immutable content identity.
- A provider release contains only its platform's vendor, repacks, collectibles, chases, search data, and required governed shared references.
- Repeated shared reference IDs across provider releases must have identical canonical bytes; manifest validation deduplicates them or fails closed.

### Manifest and lifecycle behavior

- An enabled platform is present in the approved public configuration with causally settled lifecycle `active`; `disabled` and `archived` platforms are excluded. A manifest references exactly the enabled set, once each, in canonical `platformKey` order.
- First activation requires a complete, backfilled, derivation-settled, same-epoch release for every enabled platform.
- Later ordinary delay reuses that provider's release from the active manifest. A first-time or newly enabled provider without an eligible release blocks activation.
- Disabling a provider changes public data only when a new manifest omitting it activates; provider completion alone never changes visibility.
- Provider completed heads advance independently. Active provider heads are derived only from the active manifest and are tracked separately.

### Public identity and freshness

- The manifest's public content identity is exposed through the existing `publicReleaseId`; it changes only when provider references or governing public content change.
- When the reference set is unchanged, a monotonic active-state refresh updates freshness without minting a manifest, rewriting immutable rows, or expiring valid cursors.
- Launch manifests contain at most the eight registered public platforms. Full-text collectible search runs one release-filtered indexed search per selected platform and merges the bounded results deterministically; it never searches historical releases and post-filters them. Raising the active-platform cap requires a versioned contract change plus hosted correctness and latency evidence.
- `delayedVendorCount` counts enabled platforms whose selected release checkpoint trails that platform's latest affected settled/source head or whose settled source state is delayed; `freshness` is delayed when that count is nonzero.
- Aggregate `dataAsOf`, `lastSuccessfulObservationAt`, and `staleAt` use the oldest applicable selected-provider value so the existing global freshness DTO never overstates a delayed provider.
- Existing public query inputs, DTOs, errors, search/facet/detail behavior, Heat DTOs, and release-change cursor reset remain unchanged.

### Publication, Heat, and retention

- Publication has two durable phases: provider releases complete concurrently per platform, then one organization/deployment manifest lane serializes activation with an expected-active-manifest compare-and-swap.
- PostgreSQL persists exact canonical request bytes and signed terminal receipts for both phases. Startup accepts only proven-empty state or an exact active-manifest proof covering every provider receipt.
- Heat keeps its independent minute cadence and organization-global settlement, but every frame binds the active manifest hash and exact provider-release-set digest.
- Retention keeps at most five complete manifests under normal policy: active, previous, and three additional seven-day candidates. It protects all releases referenced by those manifests, each provider's completed/active head, in-flight work, and authorized recovery targets, then keeps at most three additional seven-day complete releases per provider. The normal worst case is therefore eight complete releases for one provider when all five retained manifests reference different releases, plus bounded 24-hour staging/failed artifacts; explicit protected work may temporarily raise that count.
- The launch cutover directly replaces the unlaunched single-release publication state; there are no compatibility shims, aliases, dual reads, or dual writes.

## Out of Scope

### Data and interface non-goals

- Raw provider payloads, raw pulls, actor data, credentials, internal run IDs, tenant identifiers, or quarantine details in Convex.
- Convex-to-PostgreSQL writes or treating Convex as canonical storage.
- A second public DTO, provider-release public API, public provider freshness breakdown, or frontend redesign.
- Per-row or per-provider direct writes from ingestion workers to Convex.
- Atomic coupling between catalog manifest activation and Heat publication.

### Platform and rollout non-goals

- Provider-specific branches in generic settlement, publication, manifest, retention, or Heat orchestration.
- A generic event-stream platform, new provider transports, or provider mapping changes unrelated to publication.
- Public-configuration proposal/review UI; the publisher consumes an already approved PostgreSQL configuration epoch.
- Compatibility support for the unlaunched single-release Convex schema or global catalog promotion lane.
- Destructive removal of canonical PostgreSQL history, normalized Heat observations, or approved configuration during cutover.

## Historical Foundation Tasks

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 001 | Establish causal public-change settlement | large | 2–4 days | done | none |
| 002 | Assemble deterministic catalog releases | large | 2–4 days | done; historical global baseline | 001 |
| 003 | Stage and atomically activate Convex releases | large | 2–4 days | done; historical global baseline | none |
| 004 | Run and reconcile catalog promotions | large | 2–4 days | done; historical global baseline | 002, 003 |

## Historical Heat Tasks

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 005 | Normalize settled live Heat observations | medium | 1–3 days | done | 001 |
| 006 | Publish release-aligned Heat frames | large | 2–4 days | done; alignment superseded | 004, 005 |

## Provider-Manifest Foundation Tasks

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 007 | Establish provider-impact catalog settlement | large | 2–4 days | done | 001 |
| 008 | Assemble deterministic provider releases | large | 2–4 days | done | 007 |
| 009 | Complete provider releases without public activation | large | 3–5 days | not started | 008 |
| 010 | Compose and atomically activate catalog manifests | large | 3–5 days | not started | 009 |

## Provider-Manifest Operations Tasks

| ID | Task | Scope | Estimate | Status | Depends on |
|---|---|---|---|---|---|
| 011 | Promote providers and reconcile manifests | large | 3–5 days | not started | 007, 008, 009, 010 |
| 012 | Align Heat to the active catalog manifest | large | 2–4 days | not started | 006, 010, 011 |
| 013 | Retain manifests and provider releases safely | medium | 1–3 days | not started | 009, 010 |
| 014 | Certify provider-manifest cutover and readiness | large | 3–5 days | not started | 007–013 |

## Build Order

### Provider-manifest foundation

1. Build `007` on the completed causal ledger so provider catalog checkpoints no longer depend on unrelated provider settlement.
2. Build `008` against that provider checkpoint and lock deterministic same-epoch reuse.
3. Build `009` so provider releases can complete with exact receipts and no public side effect.
4. Build `010` so one validated manifest and pointer expose the provider union through unchanged public contracts.

### Operations and certification

1. After `010`, build `011` and `013` in parallel: orchestration owns durable two-phase progress while retention owns the protected reference graph.
2. Build `012` after `011` supplies exact active-manifest/provider receipt proof.
3. Finish `014` after `011`, `012`, and `013` to rehearse the clean cutover and certify the full failure matrix.

## Dependency Graph

```text
001 -> 007 -> 008 -> 009 -> 010
010 -> 011 -> 012
006 -----------------> 012
009 -> 013 <- 010
007..013 -> 014
```

## Parallel Groups

### Historical completed groups

- Group A: `001`, `003`
- Group B after `001`: `002`, `005`
- Group C after `002` and `003`: `004`
- Group D after `004` and `005`: `006`

### Provider-manifest groups

- Group E after `001`: `007`
- Group F after `007`: `008`
- Group G after `008`: `009`
- Group H after `009`: `010`
- Group I after `010`: `011`, `013`
- Group J after `011`: `012`
- Group K after `011`, `012`, and `013`: `014`

## Next Action

Open `009-complete-provider-releases-without-public-activation.md` and define the invisible provider-release completion protocol, exact receipt proof, and monotonic reuse confirmation before adding manifest activation.
