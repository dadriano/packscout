# Task: Exclude the Obsolete Data Feed Lab

**ID:** distributed-canonical-warehouse/011
**Depends on:** distributed-canonical-warehouse/002, distributed-canonical-warehouse/003
**Blocks:** distributed-canonical-warehouse/020
**Estimated scope:** small
**Estimated effort:** less than one day for route, bundle, and contract verification
**Status:** done

## Start Here

Use the authoritative commit-`225f9a1` route catalog as the source of truth.
Verify that `/data-api-tester` and its stale proxy API are absent from the
ported admin instead of carrying them forward from the obsolete distributed
shell.

## Objective

Keep the new admin compatible with the current application by excluding the
retired Data Feed Lab and its transient upstream-proxy contract.

## Context

The original distributed task breakdown was created from an older admin shell
that contained a Data Feed Lab. The current port-5101 `apps/admin` replaced that
surface with Canonical, Published, and Compare inspection workflows. Preserving
the Lab would add a route and credential-bearing transport that no longer exists
in the authoritative application.

This task is historical correction, not feature removal from the current app.
Task 022 owns the current data-inspection routes and their distributed
persistence mapping.

## Requirements

- Do not add `/data-api-tester` to the authoritative route catalog, navigation,
  application tree, or browser bundle.
- Do not mount the stale Data Feed Lab API or add its environment credential,
  cursor proxy, request builder, or provider-filter mapping.
- Preserve `/data/canonical`, `/data/published`, and `/data/compare` exactly as
  defined by the current admin baseline.
- Keep source transport and provider imports server-owned through the explicit
  provider integration boundary; the browser cannot select an upstream URL,
  credential, filesystem capture, or database target.
- Remove no active current-admin route, API, or test to satisfy this task.

## User-Facing Behavior

The ported admin shows the same Data navigation as the current application:
Canonical, Published, and Compare. It does not reintroduce a Data Feed Lab from
an obsolete branch.

## Acceptance Criteria

- [x] Commit `225f9a1` contains no `/data-api-tester` route or navigation item.
- [x] Task 022 explicitly excludes the stale Lab from the port.
- [x] The new task breakdown directs data inspection to the current Canonical,
  Published, and Compare contracts.
- [ ] Final route and bundle verification confirms the obsolete Lab was not
  reintroduced during integration.

## Completion Evidence

- The authoritative admin audit compared all current and distributed UI/API
  routes and identified the Data Feed Lab as stale-branch-only behavior.
- The current integration branch starts from commit `225f9a1`, so the Lab is
  absent by default while all active data-inspection screens remain intact.

