import { AdminApiError } from "../../api/client";

/**
 * Failure and outcome copy for the beta-allowlist screen, derived from the
 * admin's own stable codes. The product-backend integration never reports a
 * raw upstream error, so there is nothing here to restate beyond what the
 * admin service already decided to say.
 */
export interface AllowlistFailure {
  readonly title: string;
  readonly description: string;
  /** False when retrying the same request cannot help. */
  readonly retryable: boolean;
}

export function describeAllowlistFailure(error: unknown): AllowlistFailure {
  if (error instanceof AdminApiError) {
    if (error.code === "BETA_ALLOWLIST_UNCONFIGURED") {
      return {
        title: "The beta allowlist is not connected.",
        description:
          "This admin service has no configured connection to the product backend, so allowlist entries cannot be listed or changed. Nothing has been changed; configure the integration on the server and reload.",
        retryable: false,
      };
    }
    if (error.code === "INVALID_BETA_ALLOWLIST_CURSOR") {
      return {
        title: "This page of the allowlist is no longer valid.",
        description:
          "The allowlist moved on while you were paging through it. Return to the first page to continue.",
        retryable: false,
      };
    }
    if (error.status === 429) {
      return {
        title: "Too many allowlist requests.",
        description: "Wait a moment before searching or paging again.",
        retryable: true,
      };
    }
    return {
      title: "The beta allowlist could not be loaded.",
      description: `${error.message} Nothing has been changed.`,
      retryable: true,
    };
  }
  return {
    title: "The beta allowlist could not be loaded.",
    description:
      "PackScout Admin is temporarily unavailable. Nothing has been changed.",
    retryable: true,
  };
}

/**
 * The message a failed add or edit shows inside the form. Server messages on
 * this surface are already human copy — a duplicate names the identifier kind
 * that collided, validation names the field — and never a raw backend body.
 */
export function describeAllowlistActionError(error: unknown): string {
  if (error instanceof AdminApiError) return error.message;
  return "PackScout Admin is temporarily unavailable. Nothing has been changed.";
}

/**
 * The success announcement for an add or edit, always reporting the effect on
 * people already waiting: an operator who adds an address while the invitee
 * is stuck on the waiting screen must see that the add let them in.
 */
export function describeAllowlistChangeOutcome(
  action: "added" | "updated",
  admittedCount: number,
): string {
  const lead = `Allowlist entry ${action}`;
  if (admittedCount === 0) {
    return `${lead}. No waiting accounts matched it, so nobody was admitted by this change.`;
  }
  if (admittedCount === 1) {
    return `${lead}, and admitted 1 waiting account.`;
  }
  return `${lead}, and admitted ${admittedCount} waiting accounts.`;
}
