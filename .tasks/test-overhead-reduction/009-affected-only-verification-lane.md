# Task: Add a fast verification lane for the inner loop

**ID:** test-overhead-reduction/009
**Depends on:** test-overhead-reduction/006, test-overhead-reduction/007
**Blocks:** none
**Estimated scope:** medium
**Status:** todo

## Objective

A developer or agent iterating on a change can verify just the parts of the repository their change affects, so the full gate stops being the only available check.

## Context

The repository has exactly one verification command, and it verifies everything. That is correct as a pre-handoff contract, but it means an agent iterating on a single frontend component pays for the database test lanes, the worker compilation, and the full production build on every check.

The canonical standard's definition of done requires the full gate before handoff, and this task does not change that. What it adds is a narrower option for the loop *before* handoff, where the cost is paid many times over.

The measured shape of the problem: the full gate is roughly 246 seconds today. A change confined to one workspace needs a fraction of that to get useful signal. An agent that runs the full gate five times while iterating spends twenty minutes on verification, most of it re-checking code it never touched.

This depends on tasks 006 and 007 because the fast lane should inherit the database and concurrency improvements rather than encoding a slower arrangement that then diverges.

## Requirements

- A single command determines which workspaces a working-tree change affects and verifies only those, including workspaces that depend on a changed shared package.
- Dependency awareness is real: changing a shared package verifies the applications that consume it, not just the package itself.
- The narrow lane is clearly distinguished from the canonical gate in both naming and output, so nobody mistakes a passing quick check for a completed handoff.
- The canonical full gate remains mandatory at handoff and is not weakened, renamed, or made conditional by this task.
- When the affected set cannot be determined confidently, the command falls back to verifying everything rather than silently checking less.
- Changes to shared tooling, configuration, or the repository's own policy scripts correctly widen the affected set.
- The lane is documented where a builder or agent will find it, including an explicit statement that it does not replace the full gate.

## User-Facing Behavior

A developer or agent working on one area runs the quick command and gets lint, type check, and test results for just that area and its dependents, in a fraction of the time. The output states plainly that this is not the full gate.

## Interface Contract

Consumes the per-workspace phase commands that task 007 keeps independently invocable. Does not modify, wrap, or replace the canonical verification command, which other tooling and CI continue to call directly.

## Acceptance Criteria

- [ ] A change confined to one workspace verifies that workspace and its dependents, and skips unrelated ones.
- [ ] A change to a shared package verifies the applications that consume it.
- [ ] A change to shared tooling or configuration widens the affected set appropriately.
- [ ] An indeterminate affected set falls back to full verification.
- [ ] The command's output makes clear it is not the canonical gate.
- [ ] The canonical gate still runs everything and remains the handoff requirement.

## Verification

Modify a file in a single leaf workspace and confirm the quick command verifies that workspace, skips unrelated ones, and exits 0. Then modify a shared package and confirm the command also verifies the applications depending on it. Introduce a deliberate error in a workspace outside the affected set and confirm the quick command still passes while the canonical gate fails — demonstrating both the narrowing and why the full gate remains mandatory.
