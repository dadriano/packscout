export type PersistenceErrorCode =
  | "CONFIG_REVISION_UNTESTED"
  | "IDEMPOTENCY_CONFLICT"
  | "NOT_FOUND"
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
