export type PersistenceErrorCode =
  | "ARCHIVE_DEADLINE_EXCEEDED"
  | "CONFIG_REVISION_UNTESTED"
  | "CURSOR_SAFETY_VIOLATION"
  | "IDEMPOTENCY_CONFLICT"
  | "NOT_FOUND"
  | "RUN_OWNERSHIP_LOST"
  | "TENANT_SCOPE_VIOLATION"
  | "UNSAFE_AUDIT_METADATA"
  | "UNSAFE_CANONICAL_ACTOR_DATA";

export class PersistenceError extends Error {
  constructor(
    readonly code: PersistenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PersistenceError";
  }
}
