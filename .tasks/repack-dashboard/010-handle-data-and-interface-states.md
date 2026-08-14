# Task: Handle Data and Interface States

**ID:** repack-dashboard/010
**Depends on:** repack-dashboard/006, repack-dashboard/007, repack-dashboard/008, repack-dashboard/009
**Blocks:** repack-dashboard/011, repack-dashboard/012
**Estimated scope:** medium
**Estimated effort:** 3–5 days for one builder, including recovery-path verification
**Status:** blocked

## Start Here

Render the missing-initial-snapshot, delayed-snapshot, no-matching-results, and unavailable-metric states beside the normal loaded Dashboard and compare their recovery actions.

## Objective

Make every reachable data and interaction state explicit so the dashboard remains truthful, stable, and recoverable when data is loading, delayed, incomplete, empty, or unavailable.

## Context

The pipeline’s fixture evidence includes normal unavailable EV results, and real provider launch evidence has not yet run. The UI cannot assume every pack has an estimate, image, category, chase, promo code, or listing URL. Snapshot publication is asynchronous and can fail while an older complete snapshot remains safe to use.

## Requirements

### Loading and Initial Availability

- Use stable-geometry loading placeholders for the shell, KPI cards, table, summaries, and inspector.
- Keep navigation, theme control, disclaimer, and Learn available while Dashboard data loads.
- When no complete snapshot has ever published, show one clear unavailable message and Retry action.
- Do not render zero KPI values, empty charts, or sample packs during initial unavailability.
- Announce completion or failure without moving keyboard focus unexpectedly.

### Empty Results

- Distinguish an empty public catalog from a valid filter/search with no matches.
- For no matches, summarize the active constraints and offer Clear filters.
- For an empty public catalog, explain that pack data is not available yet and omit action controls.
- Keep filter controls operable in the no-match state.
- Close the inspector when no visible pack can be selected.

### Partial and Unavailable Fields

- Show unavailable metric reason copy without revealing internal reason codes verbatim.
- Use a neutral PackScout placeholder for a missing pack image; keep a missing chase image text-only with reserved geometry for chase name and value.
- Show uncategorized as a visible category label rather than an empty cell.
- Omit promo and Pack Link commands when public action configuration is absent.
- Keep partial packs searchable and comparable on the fields they do have.

### Delayed and Failed Refresh

- Keep the last complete snapshot readable when publication is delayed.
- Change the header status to “Some data delayed” with its last successful catalog-observation time.
- Avoid provider names, failure codes, quarantine counts, or operational recovery instructions in public copy.
- Retry failed reads without clearing valid filters, catalog position, or theme.
- Replace delayed status with updated status after a complete fresh snapshot arrives.

### Interaction Feedback

- Show Apply progress close to the filter action and prevent duplicate submissions.
- Preserve accepted results when a replacement request fails.
- Announce filter results, promo copy outcomes, and catalog page changes through appropriate live semantics.
- Keep error copy actionable and free of blame or financial certainty.
- Restore focus to the control that initiated a recoverable action.

## User-Facing Behavior

Users always know whether PackScout is loading, has no data, found no match, lacks one metric, or is showing a delayed complete snapshot. Recovery never destroys valid context.

## Interface Contract

Public snapshot states use a stable vocabulary:

| State | Required presentation |
|---|---|
| `loading` | Stable placeholders and available shell |
| `snapshot_unavailable` | No invented values, Retry, Learn remains available |
| `delayed` | Last complete data, amber status, last successful catalog-observation time |
| `empty_catalog` | No-data explanation, no pack actions |

Public result and field states use the same vocabulary:

| State | Required presentation |
|---|---|
| `no_matches` | Active-constraint summary and Clear filters |
| `field_unavailable` | Public reason copy and retained row/detail context |

## Acceptance Criteria

### Data-State Evidence

- [x] Loading, initial unavailable, delayed, empty catalog, no matches, and field unavailable are visually distinct.
- [x] No state invents zero values, sample data, promo codes, links, or imagery.
- [ ] Delayed mode retains the last complete snapshot and recovers after fresh publication.
- [x] No-match Clear filters restores the complete accepted query.
- [x] Partial records remain visible with explicit unavailable fields.

### Recovery and Feedback Evidence

- [ ] Retry preserves theme and valid query state.
- [x] A failed replacement request leaves accepted results visible.
- [ ] Apply, pagination, copy, and refresh outcomes have accessible feedback.
- [x] Inspector selection closes or falls back predictably when results change.
- [x] Public copy exposes no internal provider, tenant, run, or quarantine detail.

## Build Status

- Implemented: stable loading geometry, page-level unavailable/empty recovery, no-match constraint summary/Clear filters, field fallbacks, delayed/retained-result status, bounded live feedback, and predictable inspector fallback components under `apps/frontend`.
- Verified: catalog-state tests cover the approved public vocabulary, pending/retry outcomes, retained failures, result announcements, and constraint summaries. Mock-seed/public-read tests prove `dataSource` is explicit, mock reads fail closed in production, the seed refuses unsafe targets, and the shell presents a visible Mock data label; desktop/mobile browser QA covers loaded, search, and selection states from local Convex, while cloud-development smoke proves the same visible mock provenance plus search and selection through the HTTPS `abundant-puffin-373` read path.
- Blocked: upstream route/data tasks are blocked. No activated reactive snapshot can yet prove delayed-to-fresh recovery, Retry context preservation, or the complete Apply/pagination/clipboard/refresh announcement sequence.

## Spec Compliance

- Related specs reviewed: repack-dashboard/tech-002, repack-dashboard/tech-003, repack-dashboard/tech-004, repack-dashboard/ux-001, repack-dashboard/ux-002, repack-dashboard/ux-003, repack-dashboard/ux-004, repack-dashboard/ux-005
- Alignment: the state primitives use the specified public vocabulary, retain safe content, distinguish no-match/empty/unavailable, omit invented actions and metrics, and sanitize all buyer-facing copy.
- Divergences: reactive recovery remains represented as a frontend boundary but cannot be integrated/proven without the cloud preload/subscription path from task `003`; the local launcher and mock label do not substitute for that evidence.
- Verification: catalog-state, seed/read, and status-label tests, frontend typecheck/lint/build, responsive local-Convex browser review, and cloud-development provenance/search/selection smoke recorded green; live recovery sequences remain open.
