import type { DatabaseTargetFacts, LocalTargetDecision } from "./database-target.ts";
import {
  DATABASE_OPERATIONS,
  type DatabaseOperationDefinition,
} from "./database-operations.ts";
import type { OperationOutputLine } from "./operation-output.ts";
import type { OperationRunSnapshot } from "./operation-supervisor.ts";

/**
 * The one payload the operations surface publishes, composed in a pure function
 * so what the client is told is testable without a transport.
 *
 * `available` is the server's own answer, not a hint the client may reinterpret:
 * when it is false the UI removes the operations region entirely rather than
 * showing disabled buttons, and every route refuses regardless of what the UI
 * decided to render.
 */
export interface DatabaseOperationsSnapshot {
  readonly readAt: string;
  readonly target: DatabaseTargetFacts;
  readonly available: boolean;
  readonly unavailableReason: string | null;
  readonly operations: readonly DatabaseOperationDefinition[];
  readonly running: OperationRunSnapshot | null;
  readonly last: OperationRunSnapshot | null;
  readonly output: readonly OperationOutputLine[];
  readonly outputLineLimit: number;
  readonly timeoutMs: number;
}

export interface OperationsSnapshotInput {
  readonly readAt: string;
  readonly locality: LocalTargetDecision;
  readonly running: OperationRunSnapshot | null;
  readonly last: OperationRunSnapshot | null;
  readonly output: readonly OperationOutputLine[];
  readonly outputLineLimit: number;
  readonly timeoutMs: number;
}

export function buildDatabaseOperationsSnapshot({
  readAt,
  locality,
  running,
  last,
  output,
  outputLineLimit,
  timeoutMs,
}: OperationsSnapshotInput): DatabaseOperationsSnapshot {
  return {
    readAt,
    target: locality.target,
    available: locality.ok,
    unavailableReason: locality.ok ? null : locality.message,
    // The registry travels with the payload so the UI's tiers, consequences and
    // labels come from the same declaration the server enforces.
    operations: DATABASE_OPERATIONS,
    running,
    last,
    output,
    outputLineLimit,
    timeoutMs,
  };
}
