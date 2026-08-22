# Task: Decide Access Requests Through the Operator Integration

**ID:** closed-beta-access/003
**Depends on:** closed-beta-access/001
**Blocks:** closed-beta-access/010
**Estimated scope:** medium
**Status:** todo

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

- [ ] Approve, decline, and revoke each move the decision correctly, record operator provenance, and return the previous and resulting decisions.
- [ ] Repeat and concurrent decisions converge to the authoritative current decision without error corruption.
- [ ] An operator decline is not overturned by a subsequent allowlist addition for the same identifier.
- [ ] The queue read returns awaiting-review identities oldest-first within bounded pages, and the count matches the queue.
- [ ] Unauthenticated and ordinary product callers are rejected by every operation and read with the established error shapes.
- [ ] Deciding about an unknown subject reports that there is nothing to decide rather than creating a record.

## Verification

Product backend tests prove each operation's outcome and provenance, convergence under repeat and concurrent decisions, precedence over allowlist provenance, queue ordering and pagination bounds, count accuracy, access control on the privileged surface, and the unknown-subject outcome. The workspace typecheck and the product-backend test command exit 0.
