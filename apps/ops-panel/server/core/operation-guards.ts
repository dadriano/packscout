import type {
  DatabaseOperationDefinition,
  DatabaseOperationId,
} from "./database-operations.ts";
import { describeRegisteredOperations } from "./database-operations.ts";
import type { LocalTargetDecision } from "./database-target.ts";

/**
 * Every reason the panel refuses to run a database operation, decided in one
 * pure function so the order of the gates is a fact rather than an accident of
 * control flow.
 *
 * The decisive property is *when* this runs: the supervisor calls it at the
 * moment the operation starts, against a target it re-resolves from the
 * environment right then. A client that believed the target was local, or that
 * rendered its confirmation dialog against a database the environment has since
 * been repointed away from, is refused here — the answer it was given earlier
 * has no authority.
 *
 * Gate order, and why:
 *  1. locality — the structural gate; a non-local target is refused whatever
 *     else is true, because nothing about the request can make it local;
 *  2. busy — one operation at a time, so the operator learns what is running
 *     rather than queueing behind it invisibly;
 *  3. drift — the target moved since the dialog was rendered, which is a
 *     different mistake from mistyping and deserves a different sentence;
 *  4. acknowledgement — the typed name must match the database that is actually
 *     about to be destroyed.
 */

export type OperationRefusalCode =
  | "ops_panel_database_not_local"
  | "ops_panel_operation_busy"
  | "ops_panel_operation_target_drifted"
  | "ops_panel_operation_acknowledgement_mismatch"
  | "ops_panel_operation_unknown";

export interface OperationRefusal {
  readonly ok: false;
  readonly status: 400 | 409;
  readonly code: OperationRefusalCode;
  /** One sentence an operator can act on. Never contains credentials. */
  readonly message: string;
}

export interface OperationAdmission {
  readonly ok: true;
  /** The database name proven current at this moment, for the run record. */
  readonly database: string;
  readonly displayUrl: string;
}

export type OperationStartDecision = OperationAdmission | OperationRefusal;

export function unknownOperationRefusal(): OperationRefusal {
  return {
    ok: false,
    status: 400,
    code: "ops_panel_operation_unknown",
    message: `The operations panel runs only its registered database operations (${describeRegisteredOperations()}); it never runs a command, a path, or a statement supplied by a caller.`,
  };
}

export interface RunningOperationDescriptor {
  readonly operation: DatabaseOperationId;
  readonly label: string;
  readonly startedAt: string;
}

export interface OperationStartInput {
  readonly definition: DatabaseOperationDefinition;
  /** Re-evaluated at execution time; never a value cached from a request. */
  readonly locality: LocalTargetDecision;
  readonly running: RunningOperationDescriptor | null;
  /** The name the operator typed, for operations that demand one. */
  readonly acknowledgement?: unknown;
  /** The database the operator's dialog was rendered against, when supplied. */
  readonly expectedDatabase?: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function decideOperationStart({
  definition,
  locality,
  running,
  acknowledgement,
  expectedDatabase,
}: OperationStartInput): OperationStartDecision {
  if (!locality.ok) {
    return {
      ok: false,
      status: 409,
      code: locality.code,
      message: `${definition.label} cannot run: ${locality.message}`,
    };
  }

  const identity = locality.target.identity;
  if (identity === null) {
    // Unreachable through `requireLocalDatabaseTarget` — a local target always
    // has an identity — but the refusal is spelled out rather than asserted, so
    // a future change to the classifier cannot silently open the gate.
    return {
      ok: false,
      status: 409,
      code: "ops_panel_database_not_local",
      message: `${definition.label} cannot run: the panel could not identify the target database well enough to prove it is local.`,
    };
  }

  if (running !== null) {
    return {
      ok: false,
      status: 409,
      code: "ops_panel_operation_busy",
      message: `${running.label} is already running (started ${running.startedAt}). The panel runs one database operation at a time, so ${definition.label.toLowerCase()} was not started.`,
    };
  }

  const expected = text(expectedDatabase);
  if (expected.length > 0 && expected !== identity.database) {
    return {
      ok: false,
      status: 409,
      code: "ops_panel_operation_target_drifted",
      message: `${definition.label} was not started: it was requested against "${expected}", but the panel's database is now "${identity.database}" at ${identity.host}:${identity.port}. Re-read the target and try again.`,
    };
  }

  if (definition.acknowledgement === "database_name") {
    const typed = text(acknowledgement);
    if (typed !== identity.database) {
      return {
        ok: false,
        status: 400,
        code: "ops_panel_operation_acknowledgement_mismatch",
        message:
          typed.length === 0
            ? `${definition.label} destroys every row, so it runs only when the target database's name is typed as acknowledgement. Nothing was typed, so nothing ran.`
            : `${definition.label} was not started: the acknowledgement "${typed}" does not name the database the panel is pointed at. Nothing was changed.`,
      };
    }
  }

  return { ok: true, database: identity.database, displayUrl: identity.displayUrl };
}
