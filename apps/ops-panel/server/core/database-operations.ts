/**
 * The panel's entire vocabulary of database operations: three named actions,
 * declared here as data.
 *
 * Permanent design invariant: this list *is* the interface. No endpoint accepts
 * a command, a path, a script name, or SQL from a caller — a request names one
 * of these identifiers or it is refused, and the workspace script each one runs
 * is written here, never assembled from anything a client sent.
 *
 * Each operation delegates to a canonical workspace script rather than
 * reimplementing the work privately, so "what the panel does" and "what a
 * developer does at a terminal" cannot drift apart. Migration execution is
 * unavailable until this panel has an explicitly scoped distributed target;
 * its historical identifier remains readable in interrupted run records only.
 * The seed and reset workflows carry their existing `:local` scope.
 */

export const DATABASE_OPERATION_IDS = ["migrate", "seed", "reset"] as const;

export type DatabaseOperationId = (typeof DATABASE_OPERATION_IDS)[number];

/**
 * How much the operator has to say before the operation runs.
 *
 *  - `confirm` — a disruptive operation: state the consequence, take a click.
 *  - `database_name` — a destructive one: the operator types the name of the
 *    database that is about to be dropped, and the server checks it against the
 *    target it resolves *at execution time*.
 */
export type OperationAcknowledgement = "confirm" | "database_name";

export interface DatabaseOperationDefinition {
  readonly id: DatabaseOperationId;
  readonly label: string;
  /** Server-owned script identity; historical only when the action is unavailable. */
  readonly workspaceScript: string;
  readonly acknowledgement: OperationAcknowledgement;
  /** What the operation does, in one sentence. */
  readonly summary: string;
  /** What it will cost the operator if they were wrong. Stated before running. */
  readonly consequence: string;
  readonly destructive: boolean;
  /** A server-owned capability refusal, shown before any confirmation. */
  readonly unavailableReason?: string;
}

export const DATABASE_OPERATIONS: readonly DatabaseOperationDefinition[] =
  Object.freeze([
    Object.freeze({
      id: "migrate",
      label: "Apply migrations",
      workspaceScript: "db:prisma:migrate:deploy",
      acknowledgement: "confirm",
      summary:
        "Unavailable until the panel supports explicit central or single-provider migration targets.",
      consequence:
        "No migration is run by this panel. Use a scoped deployment command after selecting its exact target.",
      destructive: false,
      unavailableReason:
        "Migration execution is unavailable in this panel. Select central or one provider explicitly using db:prisma:migrate:deploy:central or db:prisma:migrate:deploy:provider. No database was changed.",
    }),
    Object.freeze({
      id: "seed",
      label: "Run the seed",
      workspaceScript: "db:seed:local",
      acknowledgement: "confirm",
      summary:
        "Inserts the workspace's local development rows, leaving rows that already exist alone.",
      consequence:
        "Development rows are written to the local database. Nothing is deleted, but existing data is added to.",
      destructive: false,
    }),
    Object.freeze({
      id: "reset",
      label: "Reset the database",
      workspaceScript: "db:reset:local",
      acknowledgement: "database_name",
      summary:
        "Drops the local database, re-applies every migration, and runs the seed.",
      consequence:
        "Every row in the local database is destroyed. There is no undo and the panel keeps no backup.",
      destructive: true,
    }),
  ]);

/**
 * Resolve a caller's value against the registry. Anything that is not one of
 * the three identifiers returns null, which is what makes the closed vocabulary
 * enforceable at the route rather than merely conventional.
 */
export function findDatabaseOperation(
  id: unknown,
): DatabaseOperationDefinition | null {
  if (typeof id !== "string") return null;
  return DATABASE_OPERATIONS.find((operation) => operation.id === id) ?? null;
}

export function describeRegisteredOperations(): string {
  return DATABASE_OPERATIONS.map((operation) => operation.id).join(", ");
}
