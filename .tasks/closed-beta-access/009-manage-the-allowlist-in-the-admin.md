# Task: Manage the Beta Allowlist in the Admin

**ID:** closed-beta-access/009
**Depends on:** closed-beta-access/002, admin-tools/001
**Blocks:** closed-beta-access/011
**Estimated scope:** medium
**Status:** todo

## Objective

Administrators can see, search, add, edit, and remove beta allowlist entries from the admin — the everyday tool for letting people into the closed beta before they arrive.

## Context

The allowlist is how the beta is actually run: someone gets an invitation, an administrator adds their email address or wallet address, and they walk straight in the first time they sign in. Doing that by editing the database is not an option for a beta with real invitees.

The approved reference admin's whitelist screen is the pattern to port: a searchable list of allowlisted addresses with inline add, edit, and delete, gated to top-level administrators only. PackScout adapts it to its own admin — the allowlist lives with the product backend (closed-beta-access/002), so this screen reaches it through the same server-to-server operator integration the product-users area already uses, with the credential staying server-side.

Two behaviors from closed-beta-access/002 have to be visible in the interface rather than hidden in the backend, because operators will reason about them wrongly otherwise: adding an entry admits people who are already waiting, and removing an entry does *not* evict anyone already admitted.

## Requirements

- A named permission covers viewing and managing the beta allowlist, granted to the administrator role only and withheld from data operators, enforced server-side through the admin's existing session and permission boundary. The navigation entry is hidden without it, and direct navigation shows the admin's existing access-restricted state.
- The allowlist screen lists entries with their identifiers, optional label, when they were added, and by whom; ordered by recency with bounded pagination.
- Search narrows by identifier. The no-match state is visually and textually distinct from the true empty state ("no one has been added to the allowlist yet").
- Adding an entry accepts an email address, a wallet address, or both, plus an optional label. Normalization and duplicate rejection surface as clear, human messages — never a raw backend error or a stack trace.
- A successful add reports how many waiting accounts it admitted, so the operator sees the effect rather than guessing.
- Editing an entry is supported, with the same validation and messaging as adding.
- Removing an entry requires confirmation that states the consequence explicitly: future sign-ins with that identifier will no longer be admitted automatically, and anyone already approved keeps their access — revoking a specific person is a separate action in the users area.
- Identifiers never travel in URLs, query strings, or browser history; requests carrying them follow the same non-URL convention the existing product-user listing uses. They do not appear in admin logs or metrics beyond audit-relevant identifiers.
- If the product-backend integration is unavailable, the screen degrades to a clear, non-destructive error state. No integration credential and no raw backend error body reaches the browser.
- The screen reuses the admin's existing template, ledger, form, confirmation, toast, and empty-state patterns rather than introducing new ones, and covers loading, empty, no-match, error, and forbidden states accessibly at desktop and narrow widths.
- Adding, editing, and removing entries each produce an audit record per the admin's existing conventions (acting operator, action, target identifier, timestamp, outcome).

## User-Facing Behavior

An administrator opens the Allowlist area, searches for an address, and adds an invitee by email or wallet with an optional label. A toast confirms the add and says whether anyone waiting was admitted by it. Removing an entry asks for confirmation and spells out that already-approved people keep their access. A data operator sees no Allowlist navigation and gets the access-restricted state on direct navigation.

## Interface Contract

- Protected admin endpoints for listing, creating, updating, and deleting allowlist entries, guarded by the new permission and backed by the privileged allowlist operations from closed-beta-access/002, with the admin's usual pagination and error-shape conventions.
- The create and update responses carry the count of waiting accounts admitted as a result, for display.
- The admin server owns the integration credential; it never crosses to the browser.

## Acceptance Criteria

- [ ] The permission exists, is granted to administrators only, and gates both the navigation entry and the endpoints; anonymous and data-operator requests receive the standard unauthenticated and forbidden outcomes.
- [ ] Administrators can list, search, page, add, edit, and remove entries, with normalization and duplicate rejection surfaced as clear human messages.
- [ ] A successful add reports how many waiting accounts were admitted.
- [ ] Removal requires confirmation that states both consequences — no future automatic admission, existing approvals retained.
- [ ] Identifiers never appear in URLs, query strings, or browser history, and no credential or raw backend error reaches the browser.
- [ ] Loading, empty, no-match, integration-failure, and forbidden states render accessibly at desktop and narrow widths without page-level overflow.
- [ ] Add, edit, and remove each emit an audit record per the admin's conventions.

## Verification

Admin route behavior tests prove the permission matrix (anonymous, data operator, administrator), create/update/delete outcomes including duplicate rejection and sanitized integration failures, and audit emission; page-level tests cover the list, empty, no-match, error, and forbidden states. Layout is checked at desktop and narrow widths in both themes with no page-level horizontal overflow. The admin lint, typecheck, test, and build commands exit 0.
