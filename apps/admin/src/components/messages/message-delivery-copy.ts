import type {
  EmailDeliverySkipReason,
  EmailMessageIntentState,
} from "@packscout/contracts";
import { AdminApiError } from "../../api/client";
import type { StatusTone } from "../StatusBadge";

/**
 * Operator-facing wording for the message-delivery area. The state and
 * outcome vocabularies are closed; message kinds are an open catalogue, so
 * known kinds get friendly names and an unfamiliar kind degrades to its raw
 * identifier rather than hiding.
 */

/**
 * The kinds the catalogue ships today, for the filter control and display
 * names. A kind added to the catalogue later still lists and renders — it
 * shows its raw identifier until it is named here.
 */
export const KNOWN_MESSAGE_KINDS = [
  { kind: "operational_alert", label: "Operational alert" },
  { kind: "operational_alert_recovery", label: "Alert recovery" },
  { kind: "access_approved", label: "Beta access approved" },
  { kind: "access_declined", label: "Beta access declined" },
  { kind: "welcome", label: "Welcome" },
  { kind: "operator_password_reset", label: "Operator password reset" },
  { kind: "operator_invitation", label: "Operator invitation" },
  { kind: "operator_account_created", label: "Operator account created" },
] as const;

export function messageKindLabel(kind: string): string {
  return (
    KNOWN_MESSAGE_KINDS.find((known) => known.kind === kind)?.label ?? kind
  );
}

const stateDisplay: Record<
  EmailMessageIntentState,
  { label: string; tone: StatusTone }
> = {
  pending: { label: "Pending", tone: "pending" },
  retrying: { label: "Retrying", tone: "pending" },
  sent: { label: "Sent", tone: "ready" },
  skipped: { label: "Skipped", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
};

export function messageStateDisplay(state: EmailMessageIntentState): {
  label: string;
  tone: StatusTone;
} {
  return stateDisplay[state];
}

const skipReasonCopy: Record<EmailDeliverySkipReason, string> = {
  delivery_disabled: "Delivery is disabled in this environment.",
  console_mode: "Delivery ran in local console mode.",
  missing_configuration: "No delivery provider is configured.",
};

export function skipReasonLabel(reason: EmailDeliverySkipReason): string {
  return skipReasonCopy[reason];
}

export interface MessageDeliveryFailure {
  readonly title: string;
  readonly description: string;
  /** Whether trying the same request again could reasonably succeed. */
  readonly retryable: boolean;
}

/**
 * A bounded operator-facing description of a failed read. Only the admin's
 * own stable codes are branched on; no backend text is restated.
 */
export function describeMessageDeliveryFailure(
  error: unknown,
): MessageDeliveryFailure {
  if (error instanceof AdminApiError) {
    if (error.code === "INVALID_MESSAGE_DELIVERY_CURSOR") {
      return {
        title: "This page position is no longer valid.",
        description:
          "The listing has moved on since this position was issued. Return to the first page to continue.",
        retryable: false,
      };
    }
  }
  return {
    title: "The delivery records are temporarily unavailable.",
    description:
      "Nothing has been changed. The queue keeps delivering on its own; try again once the connection recovers.",
    retryable: true,
  };
}

/** A bounded operator-facing sentence for a retry that did not happen. */
export function describeRetryError(error: unknown): string {
  if (error instanceof AdminApiError) {
    if (error.code === "MESSAGE_DELIVERY_RETRY_NOT_TERMINAL") {
      // The server's copy names the current state from a closed vocabulary.
      return error.message;
    }
    if (error.code === "MESSAGE_DELIVERY_INTENT_NOT_FOUND") {
      return "This delivery record no longer exists. Its history may have been pruned.";
    }
  }
  return "The retry could not be recorded. Nothing has been queued; try again.";
}
