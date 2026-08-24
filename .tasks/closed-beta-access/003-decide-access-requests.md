# Task: Decide Access Requests Through the Operator Integration

**ID:** closed-beta-access/003
**Depends on:** closed-beta-access/001
**Blocks:** closed-beta-access/010
**Estimated scope:** medium
**Status:** done

## Objective

Operators can approve, decline, and revoke a product identity's beta access through the privileged operator integration, and can read the queue of identities waiting for a decision — the machinery the admin's review screen drives.

## Context

Not everyone who signs in during the beta will be on the allowlist. Those people land in awaiting review, and someone has to decide about them. The approved reference admin does this as a simple status flip on the user row, reversible in both directions, with no hard delete anywhere in the flow — the same shape PackScout already uses for operator-driven suspension.

This task builds the decision operations and the queue read on the product backend's privileged operator surface. The admin's screens (closed-beta-access/010) consume them; they are unreachable from browsers and product clients.

Two ordering rules matter. An operator's decision is deliberate and outranks automatic admission, so a later allowlist addition must not quietly overturn a decline. And a revocation has to bite immediately — the person who just lost access must not keep it because their session predates the decision. That property comes from closed-beta-access/001's rule that admission is resolved from the authoritative record at request time, and closed-beta-access/004 enforces it on the authenticated paths.

## Requirements

- Three operations keyed by the stable subject identity: approve (admit), decline (refuse), and revoke (return an approved identity to awaiting review). All three are reversible; none deletes anything.
- Each operation records operator provenance — acting operator, timestamp, previous decision, resulting decision — and returns the resulting effective access rather than a bare success flag.
- Operations are idempotent and convergent. Approving an already-approved identity, or two operators acting at once, resolves to the authoritative current decision and states it; it never produces an opaque failure or a corrupted state.
- An operator decision takes precedence over allowlist provenance for the same subject: a later allowlist addition does not overturn an operator's decline (the mirror of the rule in closed-beta-access/002).
- A queue read lists identities filtered by access state — at minimum those awaiting review — ordered oldest-request-first so nobody is buried by newer arrivals, with bounded pagination.
- A bounded count of how many identities are awaiting review is available, so the admin can show that work is waiting without paging the whole queue.
- Records returned to operators carry access state and decision provenance alongside the identity, standing, and saved-item information the directory already exposes, so one screen can show the whole picture.
- Every operation and read is reachable only through the authenticated server-to-server operator integration. Unauthenticated and product callers receive the established, non-leaking error shapes already used by that surface.
- Each operation produces the information the admin's audit conventions need — acting operator, target subject, action, previous and resulting decision, timestamp, outcome — with no secrets and no personal data beyond audit-relevant identifiers. Emitting the audit record itself belongs to the admin task that calls these operations.
- Deciding about an identity that has no record is not silently invented: the operation reports that there is nothing to decide about. Pre-admitting someone who has never signed in is the allowlist's job (closed-beta-access/002).

## User-Facing Behavior

Nothing directly. A product user experiences these decisions as gaining or losing access (closed-beta-access/004, closed-beta-access/007, closed-beta-access/008); operators experience them through the admin (closed-beta-access/010).

## Interface Contract

- Approve, decline, and revoke operations on the operator integration surface, each keyed by subject and each returning `{ previous, resulting }` decisions plus the resulting effective access.
- A queue read: identities filtered by access state, oldest-request-first, bounded page size, with a stable pagination contract matching the existing directory listing.
- A bounded awaiting-review count.
- Directory records exposed to operators include access state and decision provenance.
- Consumed by closed-beta-access/010.

## Acceptance Criteria

- [x] Approve, decline, and revoke each move the decision correctly, record operator provenance, and return the previous and resulting decisions.
- [x] Repeat and concurrent decisions converge to the authoritative current decision without error corruption.
- [x] An operator decline is not overturned by a subsequent allowlist addition for the same identifier.
- [x] The queue read returns awaiting-review identities oldest-first within bounded pages, and the count matches the queue.
- [x] Unauthenticated and ordinary product callers are rejected by every operation and read with the established error shapes.
- [x] Deciding about an unknown subject reports that there is nothing to decide rather than creating a record.

## Verification

Product backend tests prove each operation's outcome and provenance, convergence under repeat and concurrent decisions, precedence over allowlist provenance, queue ordering and pagination bounds, count accuracy, access control on the privileged surface, and the unknown-subject outcome. The workspace typecheck and the product-backend test command exit 0.

## Spec Compliance

- Related specs reviewed: `.tasks/closed-beta-access/_index.md` (build order; reversible flips with no hard delete); closed-beta-access/001's and 002's Spec Compliance sections — this task fills in the `decidedBy: "operator"` + `operatorId` provenance 001 reserved, and adds the operator-side half of the decline-precedence pair 002 enforces from the list side; closed-beta-access/004 and 010 as consumers.
- Alignment: `convex/productUserAccessReview.ts` registers the internal-only operations. `approveAccess`, `declineAccess`, and `revokeAccess` are one shared reversible flip keyed by the stable subject: approve converges the decision on approved, decline on declined, revoke on awaiting review, each stamping `{ state, decidedBy: "operator", operatorId, decidedAt }` and returning a discriminated outcome — `decided` with `{ action, subject, operatorId, decidedAt, changed, previous, resulting, effectiveAccess }` (exactly the audit information 010 needs), or `nothing_to_decide` for a subject with no record (reported, never invented; pre-admitting someone who never signed in stays 002's job). Repeats and concurrency converge: an operation whose target state already holds writes nothing, reports `changed: false`, and states the stored decision with its original provenance intact, while Convex serializability orders concurrent operators so both learn the authoritative result. The operator decline outranks the allowlist as a pair: 001/002's establishment and retroactive-admission paths never re-evaluate declined records, and the paired test drives decline → `createEntry`/`updateEntry`/`establishAccess` and proves the decline stands with provenance untouched. `listAccessQueuePage` lists identities in any one decision state (awaiting review at minimum), oldest-request-first — a decision's queue position is its `decidedAt`, which for default provenance is `firstSeenAt`, the time the identity entered review — within the directory's page bounds (1–20) and cursor discipline; `countAwaitingReview` is the bounded count. Both merge records that predate the closed beta (no stored `access`) through the undefined segment of the new `by_access_state_and_access_decided_at` index on `productUsers` (schema.ts), so pre-beta sign-ups are queued and counted as the awaiting-review identities they already read as. Queue rows are the directory's own rows, and `toProductUserRecord` now carries `access` — the stored decision or the derived default — so the directory listing, single-record read, standing flip, and queue all expose access state and decision provenance additively alongside identity, standing, and saved-item fields (the admin's existing consumer field-picks known fields and is unaffected). All five functions are internal and reachable only through five new POST routes on the admin-integration HTTP router in `http.ts`, authenticated with the same `PACKSCOUT_ADMIN_DIRECTORY_TOKEN` bearer secret and speaking the surface's established non-leaking error shapes; subjects and operator references travel only in JSON bodies, never in URLs, logs, or error payloads.
- Divergences: (1) Revoke is generalized to "return to awaiting review from any state": revoking a declined identity is the deliberate operator reversal 002 pointed at this task, and a revoked identity re-enters the normal admission machinery — a still-standing allowlist entry admits it again on its next contact (tested and documented; the standing lockout is decline, matching the spec's precedence rule, which names decline only). (2) A converged repeat does not rewrite the stored decision's provenance or `decidedAt` — the operation's own clock is returned separately as the outcome's `decidedAt` — so the stored decision always names what actually moved the state (an allowlist admission stays allowlist-attributed through a redundant approve). (3) The `effectiveAccess` reported to operators is the composed decision-plus-standing answer independent of the `PACKSCOUT_CLOSED_BETA` switch, mirroring 002's switch-independent maintenance: operator decisions outlive the switch position, and enforcement keeps reading `resolveProductUserEffectiveAccess`. A suspended identity's approval therefore reports `{ admitted: false, reason: "suspended" }`, never a bare success. (4) Queue pagination is the directory search's offset-cursor mode over a merged two-segment window bounded at 200 records per segment with a `queueTruncated` flag — ascending order means a hit bound cuts off only the newest arrivals while the queue is worked from the front — and the count is bounded at 500 per segment with `truncated` meaning "at least this many"; deliberately bounded reads rather than a counter or aggregate component, because the review queue drains operationally. (5) `nothing_to_decide` also carries `action`, `subject`, `operatorId`, and the operation timestamp, so 010 can audit failed decision attempts with the same field set.
- Deferred to consumers: the admin review screen, operator permission gating, and emitting the audit records themselves (010); revocation biting on the very next request on authenticated capabilities (004) and the catalog read model (005); the waiting and declined product experiences (007/008).
- Verification: `npm run typecheck:convex && npm run test:convex` → exit 0 (26 files, 226 tests passed; 19 in `convex/productUserAccessReview.test.ts`, and `convex/productUserDirectory.test.ts` updated for the additive `access` field on records — all other suites unchanged and green). `npm run scan:framework-standards:ratchet` → exit 0, 0 findings, 0 new findings. `node scripts/check-docs.mjs` → ok, 155 markdown files. `npm run typecheck:frontend` → exit 0 (generated-api consumers unaffected).
