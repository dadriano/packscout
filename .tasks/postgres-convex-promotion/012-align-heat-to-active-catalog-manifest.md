# Task: Align Heat to the Active Catalog Manifest

**ID:** postgres-convex-promotion/012
**Depends on:** postgres-convex-promotion/006, postgres-convex-promotion/010, postgres-convex-promotion/011
**Blocks:** postgres-convex-promotion/014
**Estimated scope:** large
**Estimated effort:** 2–4 days for one builder, including alignment, expiry, and receipt-proof verification
**Status:** done

## Start Here

Calculate one Heat frame for an active manifest containing A2/B1, activate a manifest containing A3/B1, and prove the old frame becomes unavailable until a frame bound to the new manifest and exact A3/B1 provider set is complete.

## Objective

Bind every observed Heat frame to the active global manifest and its exact provider-release set while preserving Heat's independent cadence, organization-global settlement, privacy, and fail-closed expiry.

## Context

The completed Heat lane identifies one global catalog release. The new catalog read model is one manifest over several independently completed provider releases. A manifest change can replace, reuse, add, or remove provider content, so matching only a legacy release ID is insufficient. Heat must prove the same manifest and provider set the public catalog currently resolves.

## Requirements

### Frame inputs and identity

- Resolve the active catalog only from the exact PostgreSQL/Convex manifest proof established by `011`, including manifest identity/hash, configuration epoch, canonical provider-release references, and active public repack IDs.
- Continue using the organization-global settled checkpoint from `001` for normalized Heat activity and audit ordering; provider catalog checkpoints do not replace it.
- Use catalog membership, availability, and identity only from the active provider-release set. Exclude an observation that cannot be bound to a public repack in that set.
- Add the active manifest identity, manifest hash, configuration epoch, and canonical provider-release-set digest to every immutable Heat frame and terminal receipt.
- Preserve the existing aggregate labels, evidence, confidence, one-minute cadence, 15-minute current window, 24-hour baseline, and 15-minute fail-closed expiry.

### Activation and failure behavior

- Activate a Heat frame only when its manifest identity/hash and provider-release-set digest exactly match the current active manifest at finalize.
- Make a frame for the prior manifest unavailable immediately after a catalog manifest change; do not attach it to reused or newly active provider rows by public ID alone.
- Keep an aligned frame valid across metadata-only freshness refreshes that do not change manifest identity or provider references.
- Keep catalog and Heat activation independent: Heat failure cannot block manifest activation, and manifest publication failure leaves the previous aligned frame readable until normal expiry.
- Preserve bounded idempotent publication, unchanged signal-set reuse, exact lost-response reconciliation, raw-observation exclusion, and monotonic expiry guards.

## User-Facing Behavior

Heat retains its existing DTOs, labels, evidence text, unavailable behavior, and cadence. After a catalog manifest changes, Heat may briefly show the existing unavailable state until a matching frame arrives; catalog browsing remains available.

## Interface Contract

`ActiveCatalogHeatManifest` supplies the public manifest/release identity, manifest hash, configuration epoch, canonical provider-release references and digest, public repack IDs, confirmed manifest watermark, and exact terminal receipt digest.

The production Heat frame envelope adds internal alignment proof for that manifest and provider set without changing public Heat DTOs. PostgreSQL retains the exact manifest proof, frame request bytes, operation progress, and terminal receipt used by each attempt.

## Acceptance Criteria

### Alignment

- [x] A frame activates only for the exact active manifest and ordered provider-release set used to calculate it.
- [x] A changed manifest or one changed provider reference makes the prior frame unavailable until a matching frame activates.
- [x] A metadata-only catalog freshness refresh leaves the aligned Heat frame readable and does not force duplicate signals.
- [x] Disabled-provider and delayed-provider manifests calculate Heat only for repacks in their exact active provider-release union.

### Independence and recovery

- [x] Heat still reads only organization-globally settled normalized observations and publishes no raw activity or protected fields.
- [x] Heat failure does not block manifest activation; failed manifest activation preserves the prior aligned frame until expiry.
- [x] Exact replay, unchanged signal-set reuse, lost acknowledgement, restart, regressed frame, and stale expiry reconcile without duplicate active data.
- [x] Existing public Heat contract and frontend presentation tests pass without DTO changes.

## Verification

`npm run test:services && npm run test:database && npm run test:worker && npm run test:convex && npm run test:frontend`
