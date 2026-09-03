import { CentralEmailMessageOutboxRepository } from "@packscout/database";
import { EmailMessageOutboxService } from "@packscout/services";
import {
  createOperatorAccountCreatedNotifier,
  type OperatorAccountCreatedNotifier,
} from "./operator-account-created-notice.ts";

/**
 * Production composition over the durable outbox that the worker drains.
 * Enqueueing records intent only; rendering and provider delivery remain the
 * background worker's responsibility.
 */

type OperatorAccountCreatedNoticeDatabase = ConstructorParameters<
  typeof CentralEmailMessageOutboxRepository
>[0];

export function createAdminOperatorAccountCreatedNoticeRuntime(input: {
  readonly database: OperatorAccountCreatedNoticeDatabase;
}): OperatorAccountCreatedNotifier {
  return createOperatorAccountCreatedNotifier({
    outbox: new EmailMessageOutboxService({
      queue: new CentralEmailMessageOutboxRepository(input.database),
    }),
  });
}
