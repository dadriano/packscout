# Build from Tasks — Delegation Reference

Read this file when running `build` mode with parallel subagents or when phased orchestration starts to fan out.

## Phase Ownership

The orchestrator owns delivery phases and Git topology. Subagents own bounded task work inside one phase.

- Only the orchestrator creates or switches phase worktrees and branches, changes phase boundaries, records phase status, opens PRs, or restacks descendants.
- A subagent brief names exactly one phase, its direct parent branch and verified SHA, owned task IDs, permitted write scope, and required task and phase checks.
- Do not let one subagent write across phase branches or implement later-phase behavior in the current phase worktree.
- Start cross-phase parallel work only in separate worktrees after the shared parent interface is committed and verified.
- Independent adapter or surface phases may run as siblings. Do not invent dependencies or merge their changes into the open parent branch.
- Integration findings go to the earliest phase that owns the affected invariant, followed by descendant restacking and verification by the orchestrator.

## Parallel Execution Guidance

- Use the Agent tool when parallel subagent work is in scope for the build.
- Prefer one subagent per independent task or tightly related task bundle within the active phase.
- Give each subagent clear file or module ownership.
- Remind each subagent that it is not alone in the codebase and must not revert unrelated edits.
- Require each subagent to:
  - read its assigned task file or files
  - read the feature `_index.md`
  - read related `tech-*.md` and `ux-*.md` files before implementation
  - read the repository instruction file
  - explore current code patterns before editing
  - run the task's declared `## Verification` anchor and report the result, or report the fallback verification used when the task has no anchor or declares `none (no runtime surface)`
  - verify acceptance criteria before handoff
  - report spec compliance, including any divergence from related companion specs
  - report which acceptance criteria were satisfied and what evidence supports that claim
  - report the files it changed
- Do not wait idly on subagents. Use the main session for orchestration, integration, deploy, or non-overlapping work.
- The main build should already be running inside the owning phase's dedicated worktree.
- If additional isolation is needed beyond subagent forks, use extra `git worktree add` worktrees explicitly.
- For any dependency group within the current phase with several runnable tasks and low-conflict ownership, fan out subagents proactively instead of waiting for task-by-task confirmation.
- A subagent completion message is not enough on its own. The orchestrator must rerun the task's declared `## Verification` anchor, or the documented fallback when no runnable anchor exists, and verify the claimed acceptance criteria against the actual code and checks.
- If the acceptance criteria still are not met after a subagent finishes, immediately retry by spawning another subagent with the remaining gap, or continue the fix in the main session if that is faster.
- A retry subagent should inherit the latest code state and receive a narrow delta brief:
  - what already landed successfully
  - which files were changed
  - which acceptance criteria are already satisfied
  - which acceptance criteria still fail
  - what evidence or failing checks define the remaining gap
- Retry subagents should extend the existing implementation, not restart the task from scratch, unless the orchestrator explicitly decides the earlier approach must be replaced.
- After the final missing criterion is fixed, rerun the complete verification set for that task or dependency group so previously satisfied criteria are rechecked under the final combined state.

## Context Management

Prevent context bloat in both the orchestrator and subagent flows.

### Orchestrator rules

- Keep the live context focused on:
  - the current dependency group
  - the relevant task files
  - the files actually being changed
  - the current verification evidence
- Do not keep replaying full prior transcripts to new subagents. Pass a compact execution brief instead.
- Before spawning a subagent, compress the handoff into:
  - delivery phase ID and review promise
  - direct parent branch and verified parent SHA
  - task ID and title
  - related companion spec IDs and the implementation or UX guidance that matters for the task
  - owned files or modules
  - current status
  - what already landed
  - what still fails
  - the declared `## Verification` anchor and current result
  - exact acceptance criteria to satisfy
- If the orchestration thread starts carrying too much stale exploration, stop and summarize before continuing.
- If too many retries accumulate on the same task, stop spawning more subagents blindly. First write a short failure summary, identify the remaining blocker, then either narrow the next subagent's scope or continue locally.
- Prefer fewer, sharper subagents over many overlapping subagents.
- After each dependency group, reset the active context around the next group instead of carrying the full build history forward.
- After a phase publishes, reset context around the next eligible child or sibling and its direct base. Do not carry the cumulative feature diff as the next phase's review scope.

### Subagent rules

- Subagents should read only the task file, related companion specs, feature index, repo instructions, and the minimum code needed for their owned scope.
- Subagents should avoid broad repo exploration once the relevant code path is understood.
- If a subagent notices the task is larger than the brief implied, it should not silently widen scope. It should hand back a concise summary of:
  - what it confirmed
  - what it changed
  - what remains out of scope
  - what follow-up slice should be assigned next
- If a subagent's context starts getting crowded with unrelated history, it should summarize its progress and continue from the summary rather than preserving all prior detail.
- Retry subagents must start from the orchestrator's delta brief, not by reconstructing the entire task history from scratch unless necessary.
- If the remaining gap is ambiguous or spans multiple subsystems, the subagent should back off and return a narrower decomposition recommendation instead of guessing across a bloated scope.

## Backpressure Management

Do not treat every runnable task as a reason to spawn more subagents immediately. The orchestrator should control flow so integration, verification, and review stay ahead of fan-out.

### Core rules

- Cap active subagents per dependency group. Default to a small wave, usually `2-4` subagents maximum, all within one phase worktree unless sibling worktrees have explicit orchestrator ownership.
- Do not spawn a new wave while the current wave still has unreviewed results.
- Do not spawn new subagents when merge conflicts, overlapping edits, or unresolved integration failures are already present.
- Do not spawn new subagents while acceptance-criteria verification for the current group is still pending.
- Prefer serialization over parallelism when write scopes overlap or when the orchestrator cannot clearly describe ownership boundaries.
- Publish and validate a verified phase before starting another unpublished descendant on the same stack chain.
- Pause descendant fan-out when the base-most open PR has requested changes or its interface is volatile.

### Retry pressure

- Do not retry the same task indefinitely.
- After one failed subagent attempt, retry with a narrower delta brief.
- If the retry also fails or leaves the task ambiguous, stop automatic fan-out for that task.
- At that point, either:
  - continue locally in the orchestrator
  - split the remaining gap into a smaller follow-up slice
  - mark the task `blocked` with a concise explanation

### Suggested defaults

- `max_active_subagents_per_group = 3`
- `max_auto_retries_per_task = 1`
- `max_open_dependent_prs = 3`
- `spawn_next_wave_only_after_current_wave_verified = true`
- `start_child_only_after_parent_phase_verified = true`
- `publish_phase_before_next_descendant = true`
- `pause_descendant_work_on_parent_requested_changes = true`
- `serialize_when_write_scopes_overlap = true`
- `pause_spawning_when_orchestrator_context_needs_reset = true`

### Operational flow

1. Enter the owning phase worktree and confirm its direct parent SHA.
2. Spawn a small subagent wave for the current dependency group.
3. Wait for results and review the landed changes.
4. Run each task's declared `## Verification` anchor, or its documented fallback, and verify the claimed acceptance criteria.
5. Rerun the full regression pass for the group once all criteria appear satisfied.
6. Resolve conflicts or remaining gaps, then release the next wave inside the phase.
7. When all phase tasks pass, return control to the orchestrator for the phase gate, size check, publication, and stack validation.

The orchestrator should favor steady throughput over maximum concurrency. If review and verification fall behind, reduce or stop fan-out until the queue clears.

Keep task status synchronized while delegating:

1. Mark the task `in_progress` when claimed.
2. Only mark the task `done` after the orchestrator reruns and passes the declared `## Verification` anchor (or the documented fallback) and verifies the acceptance criteria.
3. Only mark the task `done` after the orchestrator verifies related companion spec compliance or records explicit divergence.
4. If a subagent fails, is interrupted, or leaves the acceptance criteria or spec-compliance gate unmet, keep the task `in_progress` while retrying or return it to `todo` or `blocked` with a note if progress must stop.
5. Subagents do not mark a phase `published` or `merged`; those states require orchestrator verification and live PR evidence.

## Worker Selection

Choose the Agent tool `subagent_type` and brief that match the task. The built-in worker is `general-purpose`; the built-in read-only investigator is `Explore`. When the repository defines custom agents (`.claude/agents/*.md`), prefer the agent whose frontmatter name matches the brief's domain (for example a repo's `senior-engineer` for `implementation` or `qa-test-engineer` for `qa`) over `general-purpose`.

| Brief | subagent_type | Use When |
|---|---|---|
| `implementation` | `general-purpose` | Default for production code, APIs, services, schemas, refactors, and bug fixes |
| `qa` | `general-purpose` | Tests, flaky test fixes, regression coverage, and test infrastructure |
| `ui-design` | `general-purpose` | Visual styling, design system work, icons, illustrations, or aesthetics-heavy component work. Prefer attaching `/frontend-skill` when the slice is primarily UI implementation. |
| `ux` | `general-purpose` | Flows, information architecture, onboarding, forms, and interaction design. Prefer `/frontend-skill` when the slice is primarily UI implementation. |
| `frontend` | `general-purpose` | User-facing UI in web or admin: pages, components, client state, layout, responsive behavior, and UI states. Attach `/frontend-skill` in the subagent brief. |
| `systems` | `general-purpose` | Agents, pipelines, MCP integrations, orchestration, or skill-system work |
| `explore` | `Explore` | Read-only investigation before implementation when ownership is unclear |
| `shell` | `general-purpose` | Git, CI, deploy scripts, and command-heavy verification |

Selection rules:

1. Read the task's Objective, Context, and Requirements before choosing.
2. If the task is primarily production code, use `general-purpose` (or the repo's implementation agent) with an implementation brief.
3. Only use a specialist brief when the task clearly falls in that domain.
4. Use only `subagent_type` values actually registered in the session — the built-ins plus the repo's `.claude/agents/*` frontmatter names. Never invent an agent name.
5. During integration, prefer focused verification in the main session and keep subagents for clearly bounded slices.
