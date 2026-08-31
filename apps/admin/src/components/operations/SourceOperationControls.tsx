import type { ProviderSourceOperationsSource } from "@packscout/contracts";

export type SourceOperationCommand = "run" | "pause" | "resume";

export interface SourceOperationControlsProps {
  source: ProviderSourceOperationsSource;
  canOperate: boolean;
  pendingKey: string | null;
  onCommand: (source: ProviderSourceOperationsSource, command: SourceOperationCommand) => void;
}

export function SourceOperationControls({ source, canOperate, pendingKey, onCommand }: SourceOperationControlsProps) {
  if (!canOperate || !source.source) return null;
  const isPending = pendingKey?.startsWith(`${source.providerId}:`) ?? false;
  const actionRequired = source.processor?.activity === "action_required";
  const runLabel = actionRequired ? "Resolve before run" : source.latestRun?.state === "failed" ? "Retry source" : "Run now";
  return (
    <div>
      <button type="button" className="admin-button admin-button-secondary" disabled={isPending || source.source.lifecycle !== "active" || actionRequired} onClick={() => onCommand(source, "run")}>{isPending ? "Working…" : runLabel}</button>
      {source.source.lifecycle === "active" ? <button type="button" className="admin-button admin-button-secondary" disabled={isPending || source.source.pauseRequested} onClick={() => onCommand(source, "pause")}>Pause</button> : null}
      {source.source.lifecycle === "paused" || source.source.pauseRequested ? <button type="button" className="admin-button admin-button-primary" disabled={isPending || actionRequired} onClick={() => onCommand(source, "resume")}>Resume</button> : null}
    </div>
  );
}
