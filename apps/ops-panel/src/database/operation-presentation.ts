import type {
  DatabaseOperationDefinition,
  DatabaseOperationsPayload,
  OperationOutcome,
  OperationOutputLine,
  OperationRunSnapshot,
} from "../api/panel-types.ts";
import { stripAnsi } from "../logs/ansi.ts";
import type { PanelTone } from "./status-presentation.ts";

/**
 * Wording, tone and enablement for the operations surface, kept out of the
 * components so the claims the panel makes are testable on their own.
 *
 * The client mirrors the server's decisions; it never makes one. Enablement
 * comes from the payload's `available` and `running` fields, the acknowledgement
 * is checked here only to keep the operator from submitting an obvious typo, and
 * every one of those checks is repeated on the server at execution time. A
 * client that believes it may run something still gets refused at the route.
 */

const OUTCOME_READINGS: Record<OperationOutcome, { tone: PanelTone; label: string }> = {
  succeeded: { tone: "ready", label: "Succeeded" },
  failed: { tone: "danger", label: "Failed" },
  timed_out: { tone: "danger", label: "Stopped on timeout" },
  unknown: { tone: "warning", label: "Outcome unknown" },
};

export function readOperationOutcome(outcome: OperationOutcome): {
  tone: PanelTone;
  label: string;
} {
  return OUTCOME_READINGS[outcome];
}

export interface OperationPaneReading {
  readonly present: boolean;
  readonly running: boolean;
  readonly title: string;
  readonly tone: PanelTone;
  readonly label: string;
  /** Closing a pane whose run is still going would hide live output. */
  readonly closable: boolean;
  readonly message: string | null;
  readonly notices: readonly string[];
}

/** What the operation pane says about the run it is showing. */
export function readOperationPane(
  run: OperationRunSnapshot | null,
): OperationPaneReading {
  if (run === null) {
    return {
      present: false,
      running: false,
      title: "No operation has run yet",
      tone: "neutral",
      label: "Idle",
      closable: true,
      message: null,
      notices: [],
    };
  }

  const running = run.outcome === null;
  const reading = running
    ? { tone: "warning" as PanelTone, label: "Running" }
    : readOperationOutcome(run.outcome as OperationOutcome);
  const notices: string[] = [];
  if (run.truncationNotice) notices.push(run.truncationNotice);
  if (run.interrupted) {
    notices.push(
      "The panel was restarted while this operation was running. It cannot say whether the operation finished, so treat the database as being in an unknown state until you have checked it.",
    );
  }

  return {
    present: true,
    running,
    title: `${run.label} — ${run.database}`,
    tone: reading.tone,
    label: reading.label,
    closable: !running,
    message: run.message,
    notices,
  };
}

export interface OperationsAvailability {
  readonly available: boolean;
  readonly reason: string | null;
  readonly busyWith: string | null;
}

/**
 * Whether the operations region is offered at all. A non-local target removes
 * it rather than disabling it: a disabled button invites the operator to look
 * for a way to enable it, and there is none.
 */
export function readOperationsAvailability(
  payload: DatabaseOperationsPayload | null,
): OperationsAvailability {
  if (payload === null) {
    return { available: false, reason: null, busyWith: null };
  }
  return {
    available: payload.available,
    reason: payload.unavailableReason,
    busyWith: payload.running ? payload.running.label : null,
  };
}

export interface AcknowledgementReading {
  readonly required: boolean;
  readonly satisfied: boolean;
  readonly prompt: string;
  readonly hint: string;
}

/**
 * The acknowledgement the operator owes before an operation runs. The typed
 * name is compared against the database the payload currently names, so an
 * operator who leaves the dialog open while the environment is repointed sees
 * their acknowledgement stop matching — and the server refuses on the same
 * grounds if they submit anyway.
 */
export function readAcknowledgement(
  definition: DatabaseOperationDefinition,
  database: string,
  typed: string,
): AcknowledgementReading {
  if (definition.acknowledgement !== "database_name") {
    return {
      required: false,
      satisfied: true,
      prompt: "",
      hint: "",
    };
  }
  const satisfied = typed.trim() === database && database.length > 0;
  return {
    required: true,
    satisfied,
    prompt: `Type ${database} to confirm`,
    hint: satisfied
      ? `This will destroy every row in ${database}.`
      : `${definition.label} runs only once the target database's name is typed exactly.`,
  };
}

/**
 * Turn a streamed line into what the pane shows: colour codes resolved to the
 * canonical plain text the log surface already defines, so "what I read" and
 * "what I copied" stay identical here too.
 */
export function toPaneLine(line: OperationOutputLine): OperationOutputLine {
  return { index: line.index, text: stripAnsi(line.text) };
}

export function describeOutputBound(payload: DatabaseOperationsPayload): string {
  return `Output is recorded up to ${payload.outputLineLimit.toLocaleString("en-US")} lines, and a run is stopped after ${Math.round(payload.timeoutMs / 1_000)}s.`;
}
