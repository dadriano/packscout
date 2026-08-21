# Feature: Admin Tools

## Context

PackScout's data pipeline is built and operable: the admin already provides operator accounts (administrator-provisioned email/password, server-side sessions, `admin` and `data_operator` roles with a named-permission vocabulary), provider configuration with secret handling and connection tests, import-run history, quarantine recovery, operational alerts, and provider freshness/quality health. Pipeline configuration therefore already lives in the admin's provider workflows.

Three operational capabilities are missing, and this feature adds them:

1. **Product-user administration.** Users sign up for the product through a third-party wallet/social auth provider and own saved repacks and saved collectibles, but no user record exists anywhere — the admin cannot see who signed up, what they have, or act on an account. This feature records sign-ups durably, gives administrators a users directory with detail views of what each user has, and adds reversible, fail-closed suspension.
2. **Worker monitoring.** The pipeline's worker fleet (schedule claiming, import runs, estimated-EV recomputation, retention) is invisible: if every worker dies, nothing says so. This feature makes worker liveness a durable fact, gives operators a fleet-monitoring view with stalled-run and overdue-schedule detection plus effective operating settings, surfaces the background queues and maintenance runs, and alerts on machinery failures through the existing alert system.
3. **A local operations panel for logs and the database.** A standalone, loopback-only workspace app — deliberately independent of product and admin authentication so it works precisely when they are broken — that live-tails every local PackScout service's logs with honest rotation/truncation handling, history browsing, deep search, and intelligent filtering, and provides a safe database surface: truthful status and migration state, a supervised embedded row browser, and three guarded operations (migrate, seed, reset), all locality-gated so nothing dangerous can touch a non-local database.

### Porting decisions

The user-administration and operations-panel designs port the approved reference admin and reference operations panel patterns rather than inventing new ones: reversible status-flip suspension with database-authoritative fail-closed enforcement, a searchable users ledger, structural (not account-based) panel security — loopback bind, origin-guarded mutations, rebinding-resistant sensitive reads, audited privileged attempts — and permanently no caller-supplied SQL or commands. The admin also adopts the reference admin's visual template outright (task 016) — its typography, token architecture, and layout patterns — so ported pages are near-copies rather than redesigns. Deliberately **not** ported: the reference fine-grained per-component ACL grant catalog (unenforced even in the reference admin — PackScout's existing role→permission vocabulary covers the need and gains two user-administration permissions instead), the reference panel's environment/secrets editor, service-supervision surface, and multi-environment/observer federation (out of scope here), and any merging of product users with admin operators (they remain separate identity systems).

## Tasks

### Admin template

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 016 | Adopt the reference admin template | medium | done | none |

### Product users and access

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 001 | Extend operator access control for user administration | small | done | none |
| 002 | Record product-user sign-ups | medium | done | none |
| 003 | Browse product users in the admin | medium | done | 001, 002 |
| 004 | Inspect what a user has | medium | todo | 001, 003 |
| 005 | Suspend and reinstate product users | medium | todo | 001, 002, 003 |

### Worker monitoring

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 006 | Track worker liveness | medium | done | none |
| 007 | Monitor the worker fleet in the admin | large | done | 006 |
| 008 | Surface background queues and maintenance runs | medium | done | none |
| 009 | Alert on worker and backlog problems | medium | todo | 006, 007, 008 |

### Local operations panel (logs and database)

| ID | Task | Scope | Status | Depends on |
|---|---|---|---|---|
| 010 | Establish the local operations panel | medium | done | none |
| 011 | Stream live logs with faithful tailing | large | done | 010 |
| 012 | Browse log history and search the past | medium | todo | 011, 013 |
| 013 | Filter logs with intelligence | large | done | 011 |
| 014 | Inspect the database safely | medium | todo | 010 |
| 015 | Run guarded database operations | medium | todo | 014 |

## Build Order

1. Start the six independent foundations in parallel: 016 (admin template), 001 (permissions), 002 (user records), 006 (worker liveness), 008 (queue visibility), 010 (panel foundation). 016 carries no hard edges, but landing it before the admin-UI tasks (003–005, 007, 008) avoids building pages on the old template and restyling them later.
2. When 001 and 002 land, build 003 (users directory); 004 (user detail, needing 001 and 003) and 005 (suspension, needing 001, 002, and 003) follow it and can run in parallel with each other.
3. When 006 lands, build 007 (fleet view); 009 (alerts) follows once 006, 007, and 008 are all in.
4. When 010 lands, 011 (live logs) and 014 (database status/browser) proceed in parallel; 013 (filtering) follows 011; 012 (history/search) follows 013, since it builds on both 011's stream and 013's filter machinery; 015 (guarded operations) follows 014.

The three tracks — product users (001–005), worker monitoring (006–009), and the operations panel (010–015) — are fully independent of each other and can be built concurrently.

## Parallel Groups

- Group A (no deps): 016, 001, 002, 006, 008, 010 — prefer finishing 016 before starting the admin-UI work in later groups
- Group B (after A): 003 (needs 001+002), 007 (needs 006), 011 (needs 010), 014 (needs 010)
- Group C (after B): 004 (needs 001+003), 005 (needs 001+002+003), 009 (needs 006+007+008), 013 (needs 011), 015 (needs 014)
- Group D (after C): 012 (needs 011+013)

## Out of Scope

- Publishing pipeline data into the product's public read model (a separate feature; not admin tooling)
- External notification delivery (email/webhook) for alerts — the existing abstract notification boundary stands
- Hard-deleting product users or their data, impersonation, or admin editing of a user's saved items
- Merging product-user and operator identity systems
- Fine-grained per-component ACL grants beyond the existing permission vocabulary
- The reference panel's environment/secrets editor, service-supervision surface, health/observer federation, and multi-environment remote access
- A SQL query runner or schema browser in the operations panel (permanent design invariant)
- Deploying the operations panel to shared or production infrastructure
