import type { ProviderSourceAdminAuditReceipt } from "@packscout/contracts";

export interface ProviderSourceAdminCommandContext {
  readonly organizationId: string;
  /** Pseudonymous server-derived actor identifier. Never a display name or email. */
  readonly actorKey: string;
}
export type ProviderSourceAdminServiceErrorCode =
  | "INVALID_SOURCE_CONFIGURATION"
  | "SOURCE_NOT_FOUND"
  | "CONNECTION_NOT_FOUND"
  | "SOURCE_CONFLICT"
  | "SOURCE_DEPENDENCY_REQUIRED"
  | "SOURCE_TEST_REQUIRED"
  | "SOURCE_UPSTREAM_UNAVAILABLE"
  | "RESET_CONFIRMATION_REQUIRED";

export class ProviderSourceAdminServiceError extends Error {
  constructor(
    readonly code: ProviderSourceAdminServiceErrorCode,
    readonly status: 404 | 409 | 422 | 424 | 503,
  ) {
    super(`provider_source_admin.${code.toLowerCase()}`);
    this.name = "ProviderSourceAdminServiceError";
  }
}

export function requireProviderSourceAdminContext(
  context: ProviderSourceAdminCommandContext,
): void {
  if (!context.organizationId.trim() || !context.actorKey.trim()) {
    throw new ProviderSourceAdminServiceError(
      "INVALID_SOURCE_CONFIGURATION",
      422,
    );
  }
}

export function providerSourceAdminAuditReceipt(
  action: ProviderSourceAdminAuditReceipt["action"],
  subjectType: ProviderSourceAdminAuditReceipt["subjectType"],
  subjectId: string,
  revisionId: string | null,
  occurredAt: Date,
): ProviderSourceAdminAuditReceipt {
  return Object.freeze({
    actor: "current_operator",
    action,
    subjectType,
    subjectId,
    revisionId,
    outcome: "success",
    occurredAt: occurredAt.toISOString(),
  });
}
