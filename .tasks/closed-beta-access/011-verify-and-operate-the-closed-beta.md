# Task: Verify and Operate the Closed Beta

**ID:** closed-beta-access/011
**Depends on:** closed-beta-access/004, closed-beta-access/005, closed-beta-access/007, closed-beta-access/008, closed-beta-access/009, closed-beta-access/010
**Blocks:** none
**Estimated scope:** medium
**Status:** todo

## Objective

The closed beta is proven end to end as one connected system, its boundary is stated rather than assumed, and it can be run day to day and opened to the public later through a documented switch.

## Context

Each preceding task verifies its own layer. None of them proves the thing the business actually cares about: that a stranger cannot get the catalog, that an invited person walks straight in, that an administrator can let someone in and have that person actually get in, and that when the beta ends the whole gate lifts cleanly.

This task closes that gap and makes the beta operable — the configuration the gate needs, how to admit and revoke people, what an unadmitted party can still see, and how to open the product to the public without a code change. It also reconciles the repository's existing behavior specifications with reality: PackScout's authentication feature currently specifies that an anonymous visitor keeps full public access, which this feature deliberately reverses. Leaving that contradiction in place would leave the next builder with two specifications and no way to know which one is true.

## Requirements

- An end-to-end behavior scenario set records the full journey, at minimum: a signed-out visitor reaches only the landing page; an allowlisted identity signs in and is in the product immediately; a non-allowlisted identity signs in and lands in review; an administrator approves a waiting visitor and that visitor reaches the product without signing in again; an administrator declines someone and they see the declined surface; a revoked user loses the product on their next navigation; a suspended user sees the suspension notice rather than the review notice; a direct call to the catalog read model without an admitted identity or the server credential is refused; and turning the switch off makes the product fully public again.
- Each scenario is marked as automated with its covering check, or as an explicit manual gap with the reason — no scenario is left implying coverage it does not have.
- Existing behavior specifications that the closed beta changes are updated rather than left contradicting it, including the authentication feature's public-access scenarios.
- Operational documentation covers every configuration value the gate depends on — the beta switch, the server-side catalog read credential, and the operator-integration secret — saying what each does, where it lives, that none of them belongs in a browser-visible variable, and what the product does when each is missing or wrong.
- A runbook covers the recurring operations: admitting someone in advance, deciding a waiting request, revoking access, and what an operator should expect the person on the other end to see in each case.
- Seeding the first allowlist entries is possible without hand-editing the database — through the admin surface or a documented operator path — so a fresh deployment can admit its first administrator.
- Opening the beta to the public is documented as a single switch with its expected effects enumerated: the landing page stops intercepting the root, gated routes render for anyone, catalog reads are public again, indexing exclusions lift, and no data or account state changes.
- The beta's boundary is stated explicitly and verified: what an unadmitted party can still observe — the landing page, the gate-status read, health probes — so the exposure is known rather than assumed.
- Documentation passes the repository's documentation checks.

## User-Facing Behavior

No new surface. The visible outcome is that the beta behaves the same way every time for every kind of visitor, and that a future decision to go public is a configuration change rather than a project.

## Interface Contract

- The behavior scenario set lives where the repository keeps its behavior specifications, alongside the feature's task files, and names the coverage for each scenario.
- Operational documentation lives with the repository's existing operator documentation; the task adds no new configuration mechanism of its own, only documents what the preceding tasks established.

## Acceptance Criteria

- [ ] The end-to-end scenario set exists with every listed journey covered, each marked automated with its check or as an explicit manual gap.
- [ ] The authentication feature's public-access scenarios are updated to describe beta-gated access.
- [ ] Every gate configuration value is documented with its purpose, location, browser-visibility rule, and missing-or-wrong behavior.
- [ ] The runbook covers admitting, deciding, revoking, and what the affected person sees in each case.
- [ ] The first allowlist entries can be seeded without hand-editing the database.
- [ ] Opening the beta is documented as one switch with its effects enumerated, and turning it off is demonstrated to restore fully public behavior.
- [ ] What an unadmitted party can still observe is stated and verified.

## Verification

The workspace's full verification command — lint, typecheck, tests, build, and the framework and documentation checks across frontend, admin, and product backend — exits 0, and the recorded end-to-end scenario set shows every listed journey either covered by a named automated check or marked as an explicit manual gap.
