# Task: Manage the Beta Allowlist in the Admin

**ID:** closed-beta-access/009
**Depends on:** closed-beta-access/002, admin-tools/001
**Blocks:** closed-beta-access/011
**Estimated scope:** medium
**Status:** done

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

- [x] The permission exists, is granted to administrators only, and gates both the navigation entry and the endpoints; anonymous and data-operator requests receive the standard unauthenticated and forbidden outcomes.
- [x] Administrators can list, search, page, add, edit, and remove entries, with normalization and duplicate rejection surfaced as clear human messages.
- [x] A successful add reports how many waiting accounts were admitted.
- [x] Removal requires confirmation that states both consequences — no future automatic admission, existing approvals retained.
- [x] Identifiers never appear in URLs, query strings, or browser history, and no credential or raw backend error reaches the browser.
- [x] Loading, empty, no-match, integration-failure, and forbidden states render accessibly at desktop and narrow widths without page-level overflow.
- [x] Add, edit, and remove each emit an audit record per the admin's conventions.

## Verification

Admin route behavior tests prove the permission matrix (anonymous, data operator, administrator), create/update/delete outcomes including duplicate rejection and sanitized integration failures, and audit emission; page-level tests cover the list, empty, no-match, error, and forbidden states. Layout is checked at desktop and narrow widths in both themes with no page-level horizontal overflow. The admin lint, typecheck, test, and build commands exit 0.

## Spec Compliance

- Related specs reviewed: `.tasks/closed-beta-access/_index.md` (reference-admin porting rule: searchable list, inline add/edit/delete, administrators only); closed-beta-access/002's Spec Compliance — this task consumes exactly the surface it documents (`POST /admin/beta-allowlist/{list,create,update,remove}`, `PACKSCOUT_ADMIN_DIRECTORY_TOKEN` bearer, entry shape, `admittedCount` on create/update, `{ entry: null }` / `{ removed: false }` convergence, 400/409/500 code sets) and restates its deferred items (null entry → "not found"; removal-semantics copy); `docs/admin-feature-baseline.md`, `docs/ui-layout-standard.md`; admin-tools/001's session/permission boundary.
- Alignment: `beta_allowlist:view` / `beta_allowlist:manage` are appended to the shared vocabulary and granted to `admin` only (`packages/contracts/src/auth.ts`), following the `product_users:*` naming; sessions derive permissions from role, so the grant is live without migration. `packages/contracts/src/beta-allowlist.ts` is the shared browser/server vocabulary (entry/row/page shapes, bounded strict request schemas, stable admin error codes), the same split `product-users.ts` uses. The admin server reaches the allowlist through `apps/admin/server/beta-allowlist-directory.ts`, a sibling of the product-user directory reader sharing the same `ProductUserDirectoryConfig` — one integration, one credential, held server-side, never serialized; every upstream failure collapses to a stable code with fixed admin copy, and duplicate refusals restate as human conflict messages naming the identifier kind, never the value. `apps/admin/server/routes/beta-allowlist.ts` guards `/list` with `beta_allowlist:view` and `/create|/update|/remove` with `beta_allowlist:manage` + CSRF + same-origin through the existing `createRequireSession` boundary; everything is POST-only with bodies (a query-string form 404s), responses are explicit bounded projections with `Cache-Control: no-store`, and `operatorId` for create is the session actor — no request shape can name one. Creator ids are enriched to display names best-effort via one bounded `listOperators` read, degrading to null names, never a failed listing. Add/edit/remove each append to the existing `audit_events` trail (`apps/admin/server/beta-allowlist-audit.ts`): acting operator, action (`beta_allowlist.add|edit|remove`), pseudonymized identifier reference keyed through the workspace secret (the product-user-audit convention), opaque entryId, outcome, admitted count, timestamp; a failed attempt is recorded before the refusal is reported, and a committed change is reported even when its audit write fails (bounded `beta_allowlist_audit_write_failed` log line, no identifier). The page (`apps/admin/src/pages/BetaAllowlistPage.tsx`) ports the ProductUsersPage pattern on the existing template: searchable ledger with recency order, bounded keyset pagination, distinct true-empty ("No one has been added to the allowlist yet.") and no-match states, forbidden → existing `AuthRestrictedState`, unconfigured/unavailable → bounded "not connected" degradation. Add/edit share one dialog (`BetaAllowlistEntryDialog`) with identical validation and messaging; success toasts always report the admitted count ("…and admitted 2 waiting accounts." / an explicit "nobody was admitted" for zero). Removal confirms both consequences verbatim — no future automatic admission, already-approved keep access, revocation lives in the Users area — through the existing confirm provider at danger tier. Navigation ("Allowlist", Workspace section) renders only with `beta_allowlist:view`.
- Divergences: (1) Two permissions (view/manage) rather than one named permission, following the repo's established `product_users:view|manage` split; both are admin-only, so the spec's grant boundary is unchanged. (2) "By whom" renders the operator's display name via the admin's own operator directory (bounded, best-effort) with the raw operator reference as fallback — the integration stores only the operator id. (3) Removing an entry that is already gone converges as a success toast ("That entry was already removed.") per 002's convergence semantics; only update restates a vanished entry as not-found, so an edit can never claim to have happened. (4) After an add the listing reloads from the top (the new entry sorts first by recency); after an edit or remove the row changes in place, per the ProductUsersPage no-reload philosophy.
- Verification: `npm run lint:admin && npm run typecheck:admin && npm run test:admin && npm run build:admin && npm run typecheck:contracts && npm run test:contracts` → all exit 0 (admin: 205 tests passed, 33 new — 10 in `server/beta-allowlist-directory.test.ts`, 11 in `server/routes/beta-allowlist.behavior.test.ts`, 12 in `src/pages/BetaAllowlistPage.test.tsx`; contracts: 162 passed, 5 new). Route tests prove the permission matrix (anonymous 401, data operator 403, cross-origin 403, missing CSRF 403, admin 200), duplicate → 409 human message, sanitized integration failures (no upstream body, secret, or personal marker in any browser payload), session-stamped `operatorId`, and audit emission for add/edit/remove including the failure and unwritable-trail paths. Page tests prove loading/empty/no-match/error/forbidden states, the admitted-count toast (2, 1, and 0 wordings), the both-consequence removal confirmation, dialog-preserved duplicate refusals, and that no rendered link or request URL carries an identifier. `npm run scan:framework-standards:ratchet` → 0 findings, 0 new. `node scripts/check-docs.mjs` → ok, 156 files. Layout smoke: real page DOM (jsdom-rendered) with the real stylesheets checked in the browser at 1280px and 375px in light and dark for list, empty, error, add-dialog, and remove-confirmation states — `scrollWidth === clientWidth` everywhere (no page-level horizontal overflow), narrow-width facts stack per the mirrored media query.
