# Task: Preserve Known Estimates Through Publication

**ID:** last-known-ev-confidence/002
**Depends on:** last-known-ev-confidence/001
**Blocks:** last-known-ev-confidence/003, last-known-ev-confidence/006
**Estimated scope:** medium
**Estimated effort:** 1 day for one builder, including release assembly and compatibility tests
**Status:** done

## Start Here

Add a release fixture whose calculable evidence is 60 minutes plus one millisecond old and prove that publication retains every EV metric instead of replacing it with `SOURCE_DATA_STALE`.

## Objective

Future releases preserve known calculable economics at every evidence age, while the existing active release remains readable without provider reimport.

## Context

Release assembly currently converts an otherwise valid stored estimate to unavailable after its V1 deadline. Existing Convex releases already contain enough calculation metadata for a read-time presentation overlay when they preserved the original estimate.

## Requirements

- Retain calculable EV metrics, source timestamp, calculation timestamp, raw V1 confidence, and limitations after the old deadline.
- Never convert age alone to `SOURCE_DATA_STALE` during release assembly.
- Preserve true unavailable reasons and positive-EV suppression unchanged.
- Accept existing active release records through an explicit versioned compatibility path with a documented removal condition.
- Require one coherent method and raw confidence-policy version per published estimate.

## User-Facing Behavior

No direct screen change. Newly assembled releases contain enough immutable evidence for current or last-known presentation without recalculating economics.

## Interface Contract

The publisher emits immutable calculation evidence. It does not persist a moving presentation score. Compatibility accepts the current V3 release shape only while the public freshness overlay is enabled; a future native shape removes that read path after every active deployment has migrated.

## Acceptance Criteria

- [x] A known 60m+1ms estimate publishes with all four metrics intact.
- [x] A missing-buyback or incomplete-odds estimate remains unavailable with unchanged bounded reason.
- [x] Existing active ClutchPacks release documents remain readable without source reimport.
- [x] Mixed method versions, malformed estimates, and raw confidence-policy relabeling fail closed.
- [x] Release fingerprints remain deterministic for immutable stored content.

## Verification

Run focused service, publication, and compatibility tests before completing this task.

## Spec Compliance

- Related specs reviewed: none; this feature has no companion tech or UX specs.
- Alignment: release assembly now preserves the immutable calculable V3 estimate after the former deadline, while unavailable evidence, positive-EV suppression, version checks, and deterministic release fingerprints remain unchanged. The additive presentation overlay accepts the unchanged active V3 shape, so no source reimport is required.
- Divergences: none.
- Verification: assembler tests passed 11/11, signed V3 client tests passed 9/9, services typecheck and lint passed, and the framework ratchet reported zero findings.
