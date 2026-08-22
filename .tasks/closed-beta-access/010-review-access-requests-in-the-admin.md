# Task: Review and Decide Access Requests in the Admin

**ID:** closed-beta-access/010
**Depends on:** closed-beta-access/003, admin-tools/003
**Blocks:** closed-beta-access/011
**Estimated scope:** medium
**Status:** todo

## Objective

Administrators can see who is waiting for beta access, approve or decline them, and revoke access from someone already admitted — all from the admin's product-users area, with confirmation and an audit trail.

## Context

The allowlist handles people who were invited in advance. This handles everyone else: the people who found PackScout, signed in, and are now waiting for a human to decide.

The admin already has a product-users ledger showing every sign-up with identity, sign-in source, standing, timestamps, and saved-item counts. This task adds the admission dimension to it — the access state and how it was decided — plus a queue view of what is waiting and the three decision actions. The approved reference admin does exactly this as a reversible status control on the user row, with no hard delete anywhere in the flow.

The distinction that has to survive contact with the interface is between *not admitted yet* and *suspended*. They look similar in a badge and mean completely different things: one is a person waiting at the door, the other is an account that was disciplined. An operator must be able to tell them apart at a glance and act on the right one.

## Requirements

- The product-users ledger shows each user's access state and how it was decided — automatically by the allowlist, by an operator, or not yet decided — alongside the standing already displayed.
- Access state and standing are visually distinguishable at a glance using the admin's existing status and badge patterns; a waiting account never looks like a suspended one.
- A review queue surfaces identities awaiting a decision, oldest request first so nobody is buried, with bounded pagination.
- How many identities are waiting is visible without paging the queue — in the navigation or the page header — so operators know work is there.
- Approve, decline, and revoke actions are available from the row or detail view, guarded by the manage-product-users permission. Each requires explicit confirmation stating what changes for that person.
- Outcomes update the row immediately and converge under repeated or concurrent action: a conflict resolves to the authoritative current decision and says so, never an opaque failure.
- Every decision produces an audit record per the admin's conventions: acting operator, target subject, action, previous and resulting decision, timestamp, outcome — with no personal data beyond audit-relevant identifiers.
- Decisions are reversible in both directions and nothing in the flow deletes a user or their data.
- Data operators see no decision controls and receive the standard forbidden outcome on direct requests; anonymous requests receive the standard unauthenticated outcome.
- If the product-backend integration is unavailable, the area degrades to a clear, non-destructive error state; no integration credential and no raw backend error body reaches the browser.
- Loading, empty queue, error, and forbidden states are covered accessibly at desktop and narrow widths, reusing the admin's existing shell, ledger, confirmation, and toast patterns.

## User-Facing Behavior

An administrator sees a waiting count in the admin, opens the review queue, and works through it oldest-first. Each row shows who the person is, how they signed in, when they arrived, and that they are awaiting review. Approving asks for confirmation, then updates the row and admits the person — who, if they are sitting on the waiting screen, is let straight into the product. Declining and revoking work the same way with their own consequences spelled out. A data operator sees the users ledger without any decision controls.

## Interface Contract

- Protected admin endpoints for approve, decline, and revoke keyed by the stable subject, guarded by the manage-product-users permission, backed by the operator decision operations from closed-beta-access/003, returning the resulting decision for immediate display.
- A protected queue listing filtered by access state with the admin's usual pagination contract, plus a bounded waiting count for the navigation or header.
- The users ledger rows carry access state and decision provenance.
- The admin server owns the integration credential; it never crosses to the browser.

## Acceptance Criteria

- [ ] The ledger shows access state and decision provenance, visually distinguishable from standing.
- [ ] The review queue lists waiting identities oldest-first with bounded pages, and the waiting count matches the queue.
- [ ] Approve, decline, and revoke each work with confirmation, update the row immediately, and emit an audit record.
- [ ] Repeated or concurrent decisions converge to the authoritative decision and report it rather than failing opaquely.
- [ ] Anonymous and data-operator requests receive the standard unauthenticated and forbidden outcomes, and data operators see no decision controls.
- [ ] Integration failure degrades to a clear non-destructive state with no credential or raw backend error in the browser.
- [ ] Loading, empty-queue, error, and forbidden states render accessibly at desktop and narrow widths without page-level overflow.

## Verification

Admin route behavior tests prove the permission matrix, each decision's outcome and convergence under repeat and concurrent action, audit emission, queue ordering and pagination bounds, count accuracy, and sanitized integration-failure mapping; page-level tests cover the queue, the access-state presentation, and the absence of decision controls for data operators. Layout is checked at desktop and narrow widths in both themes with no page-level horizontal overflow. The admin lint, typecheck, test, and build commands exit 0.
