# UX Spec: Authentication and Operator Access

**Spec ID:** ux-001  
**Related tasks:** [data-pipeline/001](001-protect-data-operations.md)  
**Depends on UX specs:** none  
**Spec status:** draft

## Purpose

Define a quiet, trustworthy sign-in experience and a clear operator-access model for the invite-only PackScout admin, including session expiry, permission differences, and admin-only account management.

## User Goals and Success Criteria

- An invited operator can sign in without needing to understand the security model.
- A signed-in operator can identify their organization, role, and available actions.
- An admin can provision, change, disable, and review operator access without exposing credentials.
- A data operator can use allowed operational tools without encountering controls that will predictably fail.
- Session problems explain the next recovery action without revealing account existence or internal errors.

## Current UX Context

The admin is a responsive React Router SPA with a fixed/sidebar-drawer shell, light/dark themes, page headers, status badges, dialogs, confirmation flows, and toast announcements. It currently has only an Overview page.

The shell says “Access controls pending,” and the Overview lists authentication as not configured. Those statements should be replaced only when real session bootstrap and authorization exist.

## Information Architecture and Navigation

### Routes

- `/login` is outside the authenticated `AdminLayout` and uses a focused branded frame.
- `/` remains the authenticated Overview and shows the current operator context.
- `/operators` is visible to admins only under a “Workspace” navigation group.
- Unknown protected routes preserve the existing not-found behavior inside the authenticated shell.

### Shell identity

Replace “Access controls pending” with a compact operator menu showing display name and role. The menu contains organization name, theme controls if retained there, and Sign out. On narrow screens it must remain reachable without competing with the navigation toggle.

## Interaction Model

### Sign in

1. Focus begins on Email; the form also contains Password and a primary “Sign in” action.
2. Submission disables repeat activation and announces “Signing in…” without clearing either field.
3. Success establishes the session and sends the operator to the safe internal return path or Overview.
4. Failure shows one generic inline summary: “We couldn't sign you in. Check your details and try again.”
5. Rate limiting uses the same account-neutral framing and tells the operator when to retry without exposing account state.

### Operator management

The operator list supports name/email search and state/role filters. Selecting a row opens a dedicated detail view or panel with identity, role, state, created date, and recent access changes.

“Add operator” opens `AdminDialog`. Role or state changes show the specific impact before confirmation. Disabling the current operator or removing the last active admin is blocked with a direct explanation.

### Permission behavior

Server-returned permissions determine navigation and actions. When a data operator can read a page but not mutate it, the page remains usable and presents read-only status instead of disabled controls with no explanation.

## Layout and Responsive Behavior

### Login

Use a single-column form no wider than comfortable reading width, centered within the existing canvas and field-note visual language. Keep the PackScout brand, one sentence of purpose, and no marketing or operational dashboard content.

### Operator list

At desktop widths, use the existing page header plus a dense ledger/table with operator, role, state, and last access. At 860px and below, transform rows into labelled stacked records rather than forcing horizontal page scrolling.

At 620px and below, the primary action becomes full width and dialogs use the available viewport with safe gutters. Critical role/state actions remain separated from routine edits.

## States and Feedback

### Authentication states

- Loading session: keep a neutral app frame or focused skeleton; do not flash protected content or the login form.
- Invalid credentials: generic inline summary, preserved email, password selectable for replacement, focus moved to the summary.
- Rate limited: retry guidance with a live countdown only if the server supplies a reliable retry time.
- Expired session: return to login with “Your session ended. Sign in again to continue.”
- Service unavailable: “PackScout Admin is temporarily unavailable. Your account has not been changed.”

### Operator states

- Empty: “No other operators yet” with Add operator for admins.
- Loading: skeleton rows that preserve headers and filter positions.
- Save pending: affected controls disabled and action copy changed to the active verb.
- Conflict: refresh the operator state and explain that another admin changed it.
- Success: update the row immediately and announce the result through the toast region.

## Accessibility

- Every field has a persistent visible label, accessible description where necessary, and inline error linked with `aria-describedby`.
- Form summaries receive programmatic focus after failed submission; errors are not communicated by color alone.
- Dialog behavior reuses `AdminDialog` focus entry, trapping, Escape, and return-focus behavior.
- Operator menus and navigation work with keyboard, visible focus, and appropriate expanded/current attributes.
- Status badges include literal state text; role and permissions never rely on icons alone.

## Visual Design Direction

Preserve the admin’s restrained field-operations identity: paper/canvas surfaces, dark pine navigation, amber action accent, strong display headings, and compact monospace metadata. Authentication should feel calm and deliberate, not like a consumer onboarding funnel.

Use one dominant surface for the form and one clear primary action. Avoid decorative metrics, multiple cards, social login treatments, or security theater copy.

## Content and Microcopy

### Login copy

- Eyebrow: “PackScout operations”
- Title: “Sign in to continue.”
- Description: “Use the operator account provided by your PackScout admin.”
- Primary action: “Sign in” / pending: “Signing in…”
- Generic failure: “We couldn't sign you in. Check your details and try again.”

### Operator actions

- Add dialog title: “Add an operator”
- Disable confirmation: “Disable access for {name}?”
- Disable consequence: “Their active sessions will end and they won't be able to sign in.”
- Role save success: “{name} is now a {role}.”
- Disabled success: “Access disabled for {name}.”

## Design System and Component Notes

- Reuse `PageHeader`, `StatusBadge`, `AdminDialog`, `ConfirmProvider`, and `ToastProvider`.
- Add form-field, error-summary, operator-menu, and responsive data-row patterns using existing CSS tokens.
- Use `danger-typed` confirmation only if disabling access is judged destructive enough to require typed identity; otherwise use the standard danger confirmation.
- Keep role/state enums in browser-safe contracts and map each to text plus an existing badge tone.
- Update `useDocumentTitle` routing so Login and Operators have accurate page titles.

## Cross-Spec and Technical Dependencies

This UX depends on session, CSRF, invite-only provisioning, role enforcement, session rotation/revocation, and stable error behavior in [tech-001](tech-001-runtime-security-and-service-boundaries.md) and [tech-005](tech-005-admin-api-and-operability.md).

The operator menu must consume server-returned permissions. It must not infer authority from route name, hidden buttons, or cached role labels.

## QA and Review Checklist

- Test sign-in success, generic failure, rate limit, pending, service unavailable, return path, and expired session.
- Test admin and data-operator navigation, direct-route access, role change, disable, conflict, and last-admin protection.
- Test keyboard-only form, menu, list, dialogs, confirmations, error focus, and sign-out behavior.
- Test screen-reader labels, live announcements, status text, reduced motion, and both themes.
- Test 1080px drawer behavior, 860px stacked records, 620px actions/dialogs, zoom, and no horizontal page overflow.

## Open Questions and Risks

- Decide the first-login credential delivery method and whether forced password replacement is part of launch.
- Confirm whether data operators can see the Operators route as read-only or should not see it at all; the current recommendation is hidden.
- Confirm whether operator email is considered sensitive enough to mask in audit/history summaries.
- A password-reset flow is out of scope, so support escalation copy must identify a real admin recovery path before launch.

## Handoff Notes

Design and build session bootstrap before adding protected data routes so the shell never flashes unauthorized content. Preserve the existing visual system and make role effects explicit in content, navigation, and confirmations.
