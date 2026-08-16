# Task: Complete Provider Releases Without Public Activation

**ID:** postgres-convex-promotion/009
**Depends on:** postgres-convex-promotion/008
**Blocks:** postgres-convex-promotion/010, postgres-convex-promotion/011, postgres-convex-promotion/013
**Estimated scope:** large
**Estimated effort:** 3–5 days for one builder, including authentication, replay, and lost-acknowledgement verification
**Status:** done

## Start Here

Publish one provider plan through authenticated start, bounded batches, status reconciliation, and finalize, then prove its completed head advances while every public query still resolves the prior active manifest.

## Objective

Accept and reconcile independently published provider releases in Convex, mark them complete, and expose a monotonic completed head per platform without changing public catalog visibility.

## Context

Provider release completion is phase one of publication. It may run concurrently for different platforms and may finish long before the release is selected by a global manifest. Completion therefore needs exact receipts and recovery semantics without an active public pointer side effect. The completed head and the active head referenced by the public manifest are intentionally different facts.

## Requirements

### Publication protocol

- Provide server-only authenticated operations for provider-release start, bounded batch apply, finalize, status/reconcile, block, and bounded cleanup using stable structured errors.
- Provide a separate authenticated `confirmReuse` operation that advances a
  provider's completed checkpoint to an exact already-complete immutable release
  without creating release, entity, search, or batch rows.
- Bind every operation to one `platformKey`, provider release identity, shared configuration epoch, source checkpoint, expected counts/hashes, operation identity, and exact canonical request digest.
- Make exact start, batch, and finalize replay idempotent; reject conflicting replay, stale provider checkpoint, wrong platform, wrong epoch, malformed data, invalid references, and blocked fingerprints without changing completed data.
- Reconcile exact counts, hashes, canonical batch order, shared references, and provider ownership before finalize.
- Keep same-epoch checkpoints strictly increasing. A configuration-epoch change
  must complete a new provider release and can never be represented as reuse.
- Bind status to operation kind, operation ID, provider release identity (when
  applicable), and the expected canonical request digest; a partial identity is
  not a successful reconciliation key.
- Authenticate timestamps, nonces, key IDs, signatures, body bounds, and schema versions without storing or returning secrets.
- Limit Task `009` cleanup to expired staging/failed publication artifacts and
  authentication nonces. Complete releases and durable terminal receipts are
  never cleanup candidates here; task `013` adds manifest-aware complete-release
  retention after the full protection graph exists.

### Completion and visibility

- Finalize the immutable provider release and advance that platform's latest completed head atomically under a monotonic predecessor guard.
- Never move the active manifest pointer, change an active provider reference, or alter public freshness when a provider release completes.
- Keep the latest completed provider head distinct from the active provider head derived from the active manifest; both must remain observable and reconcilable.
- Return exact terminal receipts through status so PostgreSQL can resolve a lost response without duplicate rows or ambiguous completion.
- Replace the prelaunch single-release storage/protocol directly; do not add dual writes, dual reads, aliases, or a compatibility branch.
- Unregister the legacy single-release write HTTP routes in this task. Keep the
  old read-only storage temporarily only because tasks `010` and `012` perform
  the coordinated public-read and Heat cutover; no new write may reach it.

## User-Facing Behavior

Users see no change when a provider release merely completes. The prior active manifest remains fully readable until a later manifest activation selects the new release.

## Interface Contract

`ProviderReleaseCompletionReceipt` identifies the operation, `platformKey`, provider release, configuration epoch, provider checkpoint, content/count/hash proof, completed-head predecessor/result, server time, and exact receipt digest.

`ProviderReleaseCompletedHead` exposes one monotonic complete release per platform for manifest planning. `ProviderReleaseActiveHead` is not writable by this protocol and is resolved only from the active manifest in task `010`.

`ProviderReleaseReuseReceipt` proves the exact existing release, configuration
epoch, prior and resulting provider checkpoint, and request digest. Reuse never
rewrites immutable release metadata or content.

`ProviderReleaseBlockReceipt` carries a PostgreSQL-authored monotonic
`blockSequence` and a bounded public reason enum. A stale block cannot replace a
newer decision. Task `009` does not add an unauthenticated or caller-selected
unblock path.

All provider publication functions are internal and authenticated. No provider release document or operational receipt is part of a public DTO.

## Acceptance Criteria

### Completion safety

- [x] Public queries and the active manifest remain unchanged throughout provider staging, batch application, and finalize.
- [x] Finalize advances only the matching platform's completed head and cannot
      regress its checkpoint; an epoch change is allowed only through a newly
      completed release with a later shared-configuration sequence, never reuse.
- [x] Exact replay returns the stored receipt; conflicting replay changes no provider or manifest state.
- [x] Exact same-epoch reuse advances only the completed checkpoint/head, creates
      no immutable rows, and rejects a changed epoch, lower/equal checkpoint,
      wrong platform, wrong release proof, or stale predecessor.
- [x] Count, hash, order, ownership, reference, block, or predecessor failure leaves the candidate non-complete and the prior completed head intact.

### Recovery and security

- [x] A lost start, batch, or finalize response reconciles to one exact PostgreSQL outcome through authenticated status.
- [x] Invalid key, signature, timestamp, nonce, body size, schema, protected field, or platform binding fails closed with a stable error.
- [x] Concurrent platforms can complete independently while concurrent attempts for one platform obey the monotonic completed-head guard.
- [x] No single-release compatibility table, dual path, or public provider-release query remains in the launch architecture.

## Verification

`npm run test:contracts && npm run test:convex && npm run typecheck:convex`

Verified on 2026-08-16: contract tests 96/96, Convex tests 48/48,
canonical `npm run verify:framework`, and a fresh-context security/correctness
audit all passed with no residual P0/P1/P2 findings.
