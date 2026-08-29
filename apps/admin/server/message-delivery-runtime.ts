import { CentralEmailMessageOutboxRepository } from "@packscout/database";
import { createMessageDeliveryAuditSink } from "./message-delivery-audit.ts";
import type { MessagesRouterDependencies } from "./routes/messages.ts";

/**
 * Wires the admin's message-delivery area to the durable email outbox the
 * background worker drains — the same repository, constructed over the same
 * database client the admin's other operational pages use. The admin only
 * reads the queue and performs the guarded requeue; delivery itself stays
 * with the worker's drain.
 */

type MessageDeliveryDatabase = ConstructorParameters<
  typeof CentralEmailMessageOutboxRepository
>[0];

export interface AdminMessageDeliveryRuntimeInput {
  readonly database: MessageDeliveryDatabase;
  readonly actorPseudonymKey: Uint8Array;
}

export function createAdminMessageDeliveryRuntime(
  input: AdminMessageDeliveryRuntimeInput,
): Omit<MessagesRouterDependencies, "auth" | "cookiePolicy" | "sameOrigin"> {
  return {
    queue: new CentralEmailMessageOutboxRepository(input.database),
    audit: createMessageDeliveryAuditSink({
      database: input.database,
      actorPseudonymKey: input.actorPseudonymKey,
    }),
  };
}
