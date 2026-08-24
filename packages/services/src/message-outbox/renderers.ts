import {
  CATALOGUE_EMAIL_MESSAGE_KINDS,
  renderAccessApprovedMessage,
  renderAccessDeclinedMessage,
  renderOperationalAlertMessage,
  renderOperationalAlertRecoveryMessage,
  renderOperatorInvitationMessage,
  renderOperatorPasswordResetMessage,
  renderWelcomeMessage,
  type AccessApprovedMessageInput,
  type AccessDeclinedMessageInput,
  type OperationalAlertMessageInput,
  type OperationalAlertRecoveryMessageInput,
  type OperatorInvitationMessageInput,
  type OperatorPasswordResetMessageInput,
  type WelcomeMessageInput,
} from "../message-catalogue/catalogue.ts";
import type { MessageCatalogueOrigins } from "../message-catalogue/origins.ts";
import type { EmailMessageRenderResult } from "../message-catalogue/rendering.ts";

/**
 * The drain's bridge from a stored intent to the message catalogue: one
 * renderer per catalogue kind, each taking the intent's stored input as
 * untyped JSON. The catalogue's own entry points validate every input and
 * report explicit failures instead of throwing, so handing them stored JSON
 * is exactly the contract they publish — a malformed stored input becomes a
 * terminal rendering failure, never a crash and never a retry.
 */

export type EmailMessageOutboxRenderer = (
  input: unknown,
  origins: MessageCatalogueOrigins,
) => EmailMessageRenderResult;

export type EmailMessageOutboxRendererMap = Readonly<
  Record<string, EmailMessageOutboxRenderer>
>;

/** Every catalogue kind, bound to its rendering entry point. */
export function createEmailMessageOutboxRenderers(): EmailMessageOutboxRendererMap {
  const renderers: Record<
    (typeof CATALOGUE_EMAIL_MESSAGE_KINDS)[number],
    EmailMessageOutboxRenderer
  > = {
    operational_alert: (input, origins) =>
      renderOperationalAlertMessage(
        input as OperationalAlertMessageInput,
        origins,
      ),
    operational_alert_recovery: (input, origins) =>
      renderOperationalAlertRecoveryMessage(
        input as OperationalAlertRecoveryMessageInput,
        origins,
      ),
    access_approved: (input, origins) =>
      renderAccessApprovedMessage(input as AccessApprovedMessageInput, origins),
    access_declined: (input, origins) =>
      renderAccessDeclinedMessage(input as AccessDeclinedMessageInput, origins),
    welcome: (input, origins) =>
      renderWelcomeMessage(input as WelcomeMessageInput, origins),
    operator_password_reset: (input, origins) =>
      renderOperatorPasswordResetMessage(
        input as OperatorPasswordResetMessageInput,
        origins,
      ),
    operator_invitation: (input, origins) =>
      renderOperatorInvitationMessage(
        input as OperatorInvitationMessageInput,
        origins,
      ),
  };
  return Object.freeze(renderers);
}
