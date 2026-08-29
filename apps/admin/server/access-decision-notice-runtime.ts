import { CentralEmailMessageOutboxRepository } from "@packscout/database";
import { EmailMessageOutboxService } from "@packscout/services";
import {
  createAccessDecisionNotifier,
  type AccessDecisionNoticeDirectoryPort,
  type AccessDecisionNotifier,
} from "./access-decision-notice.ts";

/**
 * Wires the access-decision notice to the durable email outbox the
 * background worker drains — the same repository the admin's delivery
 * history reads, constructed over the same database client, behind the
 * enqueue-side outbox service. Enqueueing records intent and returns;
 * rendering and delivery stay with the worker's drain.
 */

type AccessDecisionNoticeDatabase = ConstructorParameters<
  typeof CentralEmailMessageOutboxRepository
>[0];

export interface AdminAccessDecisionNoticeRuntimeInput {
  readonly database: AccessDecisionNoticeDatabase;
  /** The product-user directory integration the decision route already uses. */
  readonly directory: AccessDecisionNoticeDirectoryPort;
}

export function createAdminAccessDecisionNoticeRuntime(
  input: AdminAccessDecisionNoticeRuntimeInput,
): AccessDecisionNotifier {
  return createAccessDecisionNotifier({
    directory: input.directory,
    outbox: new EmailMessageOutboxService({
      queue: new CentralEmailMessageOutboxRepository(input.database),
    }),
  });
}
