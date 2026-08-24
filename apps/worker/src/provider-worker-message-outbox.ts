import {
  MessageOutboxDrainService,
  createEmailMessageOutboxRenderers,
  type EmailMessageOutboxDeliveryPort,
  type EmailMessageOutboxDrainQueue,
  type EmailMessageOutboxRendererMap,
  type MessageCatalogueOrigins,
  type MessageOutboxDrainCycleResult,
  type ProviderClock,
} from "@packscout/services";

/**
 * The provider worker's message-outbox drain job. The runtime calls it every
 * worker cycle like its other background jobs; the processor spaces real
 * drain passes on the outbox's own configured cadence and reports `waiting`
 * in between, except that a full batch opens the gate immediately so a
 * backlog drains at cycle speed instead of one batch per poll interval.
 */

export type ProviderWorkerMessageOutboxCycleResult =
  | MessageOutboxDrainCycleResult
  | { readonly outcome: "waiting" };

export interface ProviderWorkerMessageOutboxPort {
  runCycle(): Promise<ProviderWorkerMessageOutboxCycleResult>;
}

export interface ProviderWorkerMessageOutboxSettings {
  readonly batchSize: number;
  readonly perRecipientLimit: number;
  readonly leaseMilliseconds: number;
  readonly maximumAttempts: number;
  readonly backoffBaseMilliseconds: number;
  readonly backoffCapMilliseconds: number;
  readonly pollIntervalMilliseconds: number;
}

export interface ProviderWorkerMessageOutboxInput {
  readonly queue: EmailMessageOutboxDrainQueue;
  readonly delivery: EmailMessageOutboxDeliveryPort;
  readonly origins: MessageCatalogueOrigins;
  readonly clock: ProviderClock;
  readonly workerId: string;
  readonly settings: ProviderWorkerMessageOutboxSettings;
  /** Test seam; production always drains the full catalogue. */
  readonly renderers?: EmailMessageOutboxRendererMap;
}

export function createProviderWorkerMessageOutboxProcessor(
  input: ProviderWorkerMessageOutboxInput,
): ProviderWorkerMessageOutboxPort {
  const pollIntervalMilliseconds = input.settings.pollIntervalMilliseconds;
  if (
    !Number.isInteger(pollIntervalMilliseconds) ||
    pollIntervalMilliseconds < 100 ||
    pollIntervalMilliseconds > 300_000
  ) {
    throw new RangeError("Message outbox poll interval is outside its safe bounds.");
  }
  const drain = new MessageOutboxDrainService({
    queue: input.queue,
    delivery: input.delivery,
    renderers: input.renderers ?? createEmailMessageOutboxRenderers(),
    origins: input.origins,
    clock: input.clock,
    options: {
      workerId: input.workerId,
      batchSize: input.settings.batchSize,
      perRecipientLimit: input.settings.perRecipientLimit,
      leaseMilliseconds: input.settings.leaseMilliseconds,
      maximumAttempts: input.settings.maximumAttempts,
      backoffBaseMilliseconds: input.settings.backoffBaseMilliseconds,
      backoffCapMilliseconds: input.settings.backoffCapMilliseconds,
    },
  });
  let nextPassAt: number | null = null;
  return {
    async runCycle(): Promise<ProviderWorkerMessageOutboxCycleResult> {
      const startedAt = input.clock.now().getTime();
      if (nextPassAt !== null && startedAt < nextPassAt) {
        return { outcome: "waiting" };
      }
      const result = await drain.runCycle();
      const drainedFullBatch =
        result.outcome === "drained" && result.capReached;
      nextPassAt = drainedFullBatch
        ? input.clock.now().getTime()
        : input.clock.now().getTime() + pollIntervalMilliseconds;
      return result;
    },
  };
}
