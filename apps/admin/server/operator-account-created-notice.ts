import type { OperatorAccountCreatedNotificationOutcome } from "@packscout/contracts";
import type {
  EnqueueEmailMessageCommand,
  EnqueueEmailMessageResult,
  OperatorAccountCreatedMessageInput,
} from "@packscout/services";

/** The durable outbox source shared with operator invitation messages. */
export const OPERATOR_ACCOUNT_MESSAGE_SOURCE = "operator_accounts";

/**
 * One direct-provisioning event earns one notice. The new operator UUID is the
 * complete triggering identity: no address, actor, password, or hash enters
 * the idempotency key.
 */
export function operatorAccountCreatedNoticeIdempotencyKey(
  operatorId: string,
): string {
  return `operatoraccount:${operatorId}`;
}

export interface OperatorAccountCreatedNoticeInput {
  readonly operatorId: string;
  readonly toEmail: string;
}

export interface OperatorAccountCreatedNotifier {
  /**
   * Enqueues an informational email after account creation has committed.
   * It always resolves to an explicit safe outcome and never rejects.
   */
  notifyOperatorAccountCreated(
    input: OperatorAccountCreatedNoticeInput,
  ): Promise<OperatorAccountCreatedNotificationOutcome>;
}

export interface OperatorAccountCreatedNoticeOutboxPort {
  enqueueEmailMessage(
    command: EnqueueEmailMessageCommand,
  ): Promise<EnqueueEmailMessageResult>;
}

export function createOperatorAccountCreatedNotifier(dependencies: {
  readonly outbox: OperatorAccountCreatedNoticeOutboxPort;
}): OperatorAccountCreatedNotifier {
  return {
    async notifyOperatorAccountCreated({ operatorId, toEmail }) {
      // Reconstruct the rendering input field by field. Even a structurally
      // poisoned runtime caller cannot smuggle credential material into the
      // generic outbox's persisted JSON.
      const input: OperatorAccountCreatedMessageInput = { toEmail };
      let result: EnqueueEmailMessageResult;
      try {
        result = await dependencies.outbox.enqueueEmailMessage({
          kind: "operator_account_created",
          input,
          recipient: toEmail,
          idempotencyKey:
            operatorAccountCreatedNoticeIdempotencyKey(operatorId),
          source: OPERATOR_ACCOUNT_MESSAGE_SOURCE,
        });
      } catch {
        return { status: "failed", reason: "EMAIL_OUTBOX_UNAVAILABLE" };
      }
      if (result.status !== "enqueued") {
        return { status: "failed", reason: result.errorCode };
      }
      return {
        status: "enqueued",
        deduplicated: result.deduplicated,
      };
    },
  };
}
