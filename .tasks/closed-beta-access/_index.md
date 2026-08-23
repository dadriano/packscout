# Feature: Closed-Beta Access

## Context

PackScout is going into closed beta. Today the product is fully public: the site root is the dashboard, a signed-out visitor browses the whole catalog, and signing in only adds the ability to save items. This feature reverses that. The root becomes a landing page for anyone who is not admitted, every product surface requires an approved account, and people get in one of two ways — an operator adds their email address or wallet address to an allowlist in advance, or an operator approves them by hand after they sign in and land in review.

### What already exists

The pieces this feature builds on are already in place or in flight on the admin-tools branch:

- **A product-user directory.** Every sign-in is recorded durably with the stable subject identity, authentication source, verified email and/or wallet address when the provider exposes them, first- and last-seen times, and a standing of active or suspended (`admin-tools/002`, done). The product backend already exposes privileged directory reads to the admin through an authenticated server-to-server integration.
- **An operator identity system with permissions.** The admin has administrator-provisioned accounts, server-side sessions, and a named-permission vocabulary that already carries view- and manage-product-users permissions (`admin-tools/001`, done), plus a product-users ledger built on them (`admin-tools/003`, done).
- **Client-side product authentication.** Product users sign in through a hosted wallet/social provider whose tokens the product backend verifies directly. There is no server-side session on the site today, and the site's pages are server-rendered by reading an unauthenticated catalog read model.

The tasks that carry hard cross-feature dependencies name them directly (`admin-tools/001`, `admin-tools/002`, `admin-tools/003`). Those tasks are complete on the admin-tools branch; this feature assumes that work has landed where it is being built.

### The shape of the design

Admission is a new, separate dimension on the product-user record — awaiting review, approved, or declined — deliberately kept apart from the existing active/suspended standing, because the two answer different questions. Suspension asks whether a known account was disciplined, so a missing record means "never disciplined" and reads as active. Admission asks whether an account was let in, so a missing record means "not yet" and reads as awaiting review. Every consumer asks one composed question — effective access — so the two can never drift apart.

The gate is enforced in three places, because gating any one of them alone is not a closed beta: the authenticated product capabilities (so a token holder cannot save items), the catalog read model (so a stranger with the backend's public address cannot pull the whole catalog), and the site's own server-side rendering (so an unadmitted visitor never receives gated markup or embedded data). All three read the same decision, and all three are lifted by the same switch when the beta ends.

### Ported from the approved reference web app and admin

The design ports the reference implementation's patterns rather than inventing new ones: an account status defaulting to pending and flipped to active by an allowlist match at sign-in or by an operator; a small explicit set of public paths with everything else protected and a separate holding surface for signed-in-but-unapproved accounts; authoritative re-reads of the real decision on every check because a cached token can be stale; a searchable allowlist screen with inline add, edit, and delete gated to administrators; and reversible status flips with no hard delete anywhere in the flow.

Adapted rather than copied, because PackScout's stack differs: identity arrives as a third-party token instead of a registration form, so admission is established on first authenticated contact rather than at registration; the allowlist matches wallet addresses as well as email addresses, since a signed-in identity may have only a wallet; the allowlist lives with the product backend (sign-in has to consult it) and the admin reaches it through the existing server-to-server integration; and closing the catalog read model has no counterpart in the reference at all, because the reference has no public unauthenticated data surface to close.

### Decisions taken

- **Only the landing page is public during the beta.** The dashboard, the repacks surface, and the learn articles all require an admitted account.
- **The root route stays dual-purpose.** `/` renders the landing page for visitors who are not admitted and the existing dashboard for those who are. No route moves, and no existing dashboard link, filter URL, or provider-banner destination is rewritten.
- **The data API is closed, not just the UI.** Catalog reads require an admitted identity or PackScout's own server-side rendering credential, because the backend's address is a public value and an open read model would make the gate cosmetic.

## Tasks

### Access model (product backend)

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 001 | Establish the closed-beta access decision | medium | done | admin-tools/002 |
| 002 | Maintain the beta allowlist | medium | done | 001 |
| 003 | Decide access requests through the operator integration | medium | done | 001 |

### Enforcement

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 004 | Enforce approved access on authenticated capabilities | medium | done | 001 |
| 005 | Close the catalog read model to unadmitted callers | large | done | 001 |

### Product surfaces (frontend)

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 006 | Add the public landing page | medium | done | none |
| 007 | Gate the product behind approved access | large | done | 001, 006 |
| 008 | Awaiting-approval and declined experience | medium | done | 007 |

### Operator surfaces (admin)

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 009 | Manage the beta allowlist in the admin | medium | todo | 002, admin-tools/001 |
| 010 | Review and decide access requests in the admin | medium | todo | 003, admin-tools/003 |

### Launch

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 011 | Verify and operate the closed beta | medium | todo | 004, 005, 007, 008, 009, 010 |

## Build Order

1. Start 001 (the access decision) and 006 (the landing page) together — 006 has no dependency on the access model and can be built and reviewed while 001 lands.
2. When 001 lands, four tracks open in parallel: 002 (allowlist) and 003 (operator decisions) extend the model; 004 (authenticated capabilities) and 005 (catalog read model) enforce it. 007 (the frontend gate) also unblocks, needing 001 and 006.
3. 008 follows 007; 009 follows 002; 010 follows 003. These three are independent of each other.
4. 011 closes the feature once every enforcement and surface task is in.

005 is the largest and least predictable task — it touches every catalog read path and the server rendering path. Starting it early in step 2 keeps it off the critical path at the end. 007 is the other large one, and the two overlap only at the server read path: 005 owns presenting the read credential, 007 owns deciding which visitors get a page. Keep that boundary when both are in flight.

## Parallel Groups

- Group A (no deps): 001, 006
- Group B (after A): 002 (needs 001), 003 (needs 001), 004 (needs 001), 005 (needs 001), 007 (needs 001+006)
- Group C (after B): 008 (needs 007), 009 (needs 002), 010 (needs 003)
- Group D (after C): 011 (needs 004, 005, 007, 008, 009, 010)

## Out of Scope

- Email or push notification when an access request is decided. Not built here — the waiting surface reacts to the decision live, so nobody with the page open is stuck. `messaging/006` supersedes this exclusion and delivers the decision by email for people who closed the tab.
- Invite links, invite codes, referral flows, or a waitlist with positions — admission is the allowlist plus operator review, nothing more.
- A separate beta registration form or lead-capture surface. The sign-in record is the access request; no additional personal data is collected.
- Merging product users with admin operators. They remain separate identity systems, and an operator who wants product access adds their own identifier to the allowlist.
- Hard-deleting product users, their access history, or their saved items. Every decision in this feature is reversible.
- Per-feature or tiered beta access (admitting someone to part of the product). Admission is all-or-nothing.
- Changing what suspension means or how it is enforced — that stays with `admin-tools/005`; this feature only composes with it.
- Rewriting the catalog, learn, or saved-items experiences. Once a visitor is admitted, the product behaves exactly as it does today.
- Moving the dashboard off the root route, and any accompanying link or redirect rewriting.
