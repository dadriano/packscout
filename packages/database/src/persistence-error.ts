export type PersistenceErrorCode =
  | "CHECKPOINT_CYCLE_DETECTED"
  | "CONNECTION_BLOCKED"
  | "CONFIG_REVISION_UNTESTED"
  | "DERIVATION_OWNERSHIP_LOST"
  | "IDEMPOTENCY_CONFLICT"
  | "HEALTH_GENERATION_STALE"
  | "NOT_FOUND"
  | "REQUEST_ATTEMPT_TERMINAL"
  | "RUN_OWNERSHIP_LOST"
  | "SOURCE_FENCED"
  | "SOURCE_IDENTITY_CONFLICT"
  | "SUPERVISOR_OWNERSHIP_LOST"
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
