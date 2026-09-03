import { isDeepStrictEqual } from "node:util";
import type { ProviderQueryClient } from "./provider-database.ts";

type Audit = Awaited<ReturnType<ProviderQueryClient["local_audit_events"]["findMany"]>>[number];
type Command = NonNullable<Awaited<ReturnType<ProviderQueryClient["control_commands"]["findUnique"]>>>;
type Run = NonNullable<Awaited<ReturnType<ProviderQueryClient["provider_runs"]["findUnique"]>>>;
const continuation = "provider.failed_head.continuation";
const reviewedActions = new Set([continuation, `${continuation}.completed`, `${continuation}.lease_claimed`,
  "provider.runtime.resume_guard", "provider.run.requested"]);
const lifecycleActions = new Set(["provider.runtime.transition", "provider.command.terminal", "provider.run.started"]);
const at = (row: Audit, time: Date | null) => time !== null && row.occurred_at.getTime() === time.getTime();

/** Bind the normal audited Resume and queued-run start, including the runner's null actor. */
export function providerFailedHeadLifecycleMatches(input: {
  readonly audits: readonly Audit[]; readonly providerId: string; readonly operatorId: string;
  readonly operationId: string; readonly resume: Command; readonly command: Command; readonly leaf: Run;
  readonly generation: bigint; readonly completed: Audit; readonly resumeGuard: Audit; readonly requested: Audit;
}): boolean {
  const { audits, providerId, operatorId, operationId, resume, command, leaf, generation, completed, resumeGuard, requested } = input;
  if (!leaf.started_at || !resume.completed_at || !command.completed_at ||
    command.completed_at.getTime() !== leaf.started_at.getTime() ||
    resume.completed_at.getTime() !== resume.requested_at.getTime() ||
    command.requested_at.getTime() !== leaf.requested_at.getTime() ||
    completed.occurred_at > leaf.started_at || resume.completed_at > command.requested_at ||
    audits.some(row => row.correlation_id !== operationId || row.outcome !== "success" ||
      (!reviewedActions.has(row.action) && !lifecycleActions.has(row.action)) ||
      (reviewedActions.has(row.action) && row.actor_operator_id !== operatorId))) return false;
  const transitions = audits.filter(row => row.action === "provider.runtime.transition");
  const terminals = audits.filter(row => row.action === "provider.command.terminal");
  const starts = audits.filter(row => row.action === "provider.run.started");
  if (transitions.length !== 2 || terminals.length !== 2 || starts.length !== 1) return false;
  const resumed = transitions.find(row => row.command_id === resume.id);
  const running = transitions.find(row => row.command_id === null);
  const resumeTerminal = terminals.find(row => row.command_id === resume.id);
  const runTerminal = terminals.find(row => row.command_id === command.id);
  const started = starts[0]!;
  const receipt = audits.find(row => row.action === continuation);
  if (!resumed || !running || !resumeTerminal || !runTerminal || !receipt ||
    receipt.sequence >= resumed.sequence || !audits.some(row => row.action === `${continuation}.lease_claimed` &&
      row.sequence > receipt.sequence && row.sequence < resumed.sequence)) return false;
  if (resumed.actor_operator_id !== operatorId || resumed.target_type !== "provider_runtime" || resumed.target_id !== providerId ||
    !at(resumed, resume.completed_at) || !isDeepStrictEqual(resumed.details,
      { fromState: "error", toState: "idle", stateGeneration: (generation + 1n).toString() }) ||
    running.actor_operator_id !== null || running.target_type !== "provider_runtime" || running.target_id !== providerId ||
    !at(running, leaf.started_at) || !isDeepStrictEqual(running.details,
      { fromState: "idle", toState: "running", stateGeneration: (generation + 2n).toString() })) return false;
  if (resumeTerminal.actor_operator_id !== operatorId || resumeTerminal.target_type !== "control_command" || resumeTerminal.target_id !== resume.id ||
    !at(resumeTerminal, resume.completed_at) || !isDeepStrictEqual(resumeTerminal.details,
      { commandType: "resume", resultCode: "RUNTIME_TRANSITION_APPLIED", stateGeneration: (generation + 1n).toString() }) ||
    runTerminal.actor_operator_id !== operatorId || runTerminal.target_type !== "control_command" || runTerminal.target_id !== command.id ||
    !at(runTerminal, leaf.started_at) || !isDeepStrictEqual(runTerminal.details,
      { commandType: "run", resultCode: "RUN_STARTED", stateGeneration: (generation + 2n).toString() })) return false;
  if (started.actor_operator_id !== operatorId || started.command_id !== command.id ||
    started.target_type !== "provider_run" || started.target_id !== leaf.id || !at(started, leaf.started_at) ||
    !isDeepStrictEqual(started.details, { runId: leaf.id, leaseFence: leaf.worker_fence.toString() }) ||
    !at(resumeGuard, resume.completed_at) || !at(requested, command.requested_at)) return false;
  return resumed.sequence < resumeTerminal.sequence && resumeTerminal.sequence < resumeGuard.sequence &&
    resumeGuard.sequence < requested.sequence && requested.sequence < completed.sequence &&
    completed.sequence < running.sequence && running.sequence < started.sequence && started.sequence < runTerminal.sequence;
}
