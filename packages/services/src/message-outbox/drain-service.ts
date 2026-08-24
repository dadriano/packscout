import type {
  EmailDeliveryResult,
  RenderedEmailMessage,
} from "@packscout/contracts";
import type { EmailDeliveryResolution } from "../email-delivery/delivery-service.ts";
import type { MessageCatalogueOrigins } from "../message-catalogue/origins.ts";
import type { ProviderClock } from "../provider-configuration-service.ts";
import type { EmailMessageOutboxRendererMap } from "./renderers.ts";

/**
 * The background drain of the durable email outbox. Each pass claims a
 * bounded batch of due intents exclusively, renders each through the message
 * catalogue, delivers through the delivery boundary, and records the outcome.
 *
 * Classification is the heart of it: rendering failures are terminal — they
 * will not improve on retry — as are non-retryable delivery failures;
 * retryable delivery failures back off exponentially to a bounded attempt
 * limit and then rest terminally failed; skipped outcomes (delivery
 * disabled, console mode, local missing configuration) are recorded as
 * skipped, not failures. When delivery is unconfigured where configuration
 * is required, the pass defers instead of burning attempts into terminal
 * failures — the intents wait, and nothing is dropped because delivery
 * happened to be down at the moment of the trigger.
 */

const safeWorkerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const errorCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const ERROR_MESSAGE_MAX_LENGTH = 200;

export interface ClaimedEmailOutboxMessage {
  readonly intentId: string;
  readonly kind: string;
  readonly input: unknown;
  readonly recipient: string;
  readonly claimToken: string;
  readonly attemptNumber: number;
}

/** Structural subset of the database outbox repository the drain uses. */
export interface EmailMessageOutboxDrainQueue {
  claimDueBatch(input: {
    readonly workerId: string;
    readonly now: Date;
    readonly limit: number;
    readonly perRecipientLimit: number;
    readonly leaseMilliseconds: number;
  }): Promise<readonly ClaimedEmailOutboxMessage[]>;
  recordAttemptOutcome(input: {
    readonly intentId: string;
    readonly claimToken: string;
    readonly attemptNumber: number;
    readonly occurredAt: Date;
    readonly outcome:
      | {
          readonly status: "sent";
          readonly provider: string;
          readonly providerMessageId: string | null;
        }
      | {
          readonly status: "skipped";
          readonly provider: string | null;
          readonly reason:
            | "delivery_disabled"
            | "console_mode"
            | "missing_configuration";
        }
      | {
          readonly status: "failed";
          readonly provider: string | null;
          readonly errorCode: string;
          readonly errorMessage: string;
          readonly retryable: boolean;
          readonly retryAt: Date;
          readonly maximumAttempts: number;
        };
  }): Promise<"sent" | "skipped" | "retrying" | "failed" | "lost">;
}

/** The delivery boundary surface the drain needs; the delivery service is one. */
export interface EmailMessageOutboxDeliveryPort {
  resolve(): EmailDeliveryResolution;
  send(message: RenderedEmailMessage): Promise<EmailDeliveryResult>;
}

export interface MessageOutboxDrainCycleResult {
  readonly outcome: "drained" | "deferred";
  readonly claimed: number;
  readonly sent: number;
  readonly skipped: number;
  readonly retrying: number;
  readonly failed: number;
  readonly lost: number;
  /** Claims whose outcome could not even be recorded; their leases lapse. */
  readonly errors: number;
  readonly capReached: boolean;
}

export interface MessageOutboxDrainServiceOptions {
  readonly workerId: string;
  /** Intents claimed per pass; 1..100, default 25. */
  readonly batchSize?: number;
  /** Most claims one recipient contributes per pass; 1..100, default 5. */
  readonly perRecipientLimit?: number;
  /** Exclusive claim lease; 1s..15m, default 60s. */
  readonly leaseMilliseconds?: number;
  /** Attempts before a retryable failure rests terminally; 1..20, default 6. */
  readonly maximumAttempts?: number;
  /** First retry delay; doubles per attempt. 100ms..1h, default 30s. */
  readonly backoffBaseMilliseconds?: number;
  /** Ceiling on any retry delay; base..24h, default 1h. */
  readonly backoffCapMilliseconds?: number;
}

export interface MessageOutboxDrainServiceDependencies {
  readonly queue: EmailMessageOutboxDrainQueue;
  readonly delivery: EmailMessageOutboxDeliveryPort;
  readonly renderers: EmailMessageOutboxRendererMap;
  readonly origins: MessageCatalogueOrigins;
  readonly clock: ProviderClock;
  readonly options: MessageOutboxDrainServiceOptions;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${label} is outside its safe bounds.`);
  }
  return resolved;
}

/**
 * Bounded exponential backoff: the delay after failing attempt `attempt`
 * (1-based) is `base * 2^(attempt-1)`, never above the cap.
 */
export function emailOutboxBackoffMilliseconds(input: {
  readonly attempt: number;
  readonly baseMilliseconds: number;
  readonly capMilliseconds: number;
}): number {
  const attempt = Math.max(1, Math.trunc(input.attempt));
  const exponential = input.baseMilliseconds * 2 ** (attempt - 1);
  return Math.min(input.capMilliseconds, exponential);
}

function boundedErrorMessage(value: string): string {
  return value.length > ERROR_MESSAGE_MAX_LENGTH
    ? value.slice(0, ERROR_MESSAGE_MAX_LENGTH)
    : value;
}

function safeErrorCode(value: string, fallback: string): string {
  return errorCodePattern.test(value) ? value : fallback;
}

export class MessageOutboxDrainService {
  readonly #batchSize: number;
  readonly #perRecipientLimit: number;
  readonly #leaseMilliseconds: number;
  readonly #maximumAttempts: number;
  readonly #backoffBaseMilliseconds: number;
  readonly #backoffCapMilliseconds: number;

  constructor(
    private readonly dependencies: MessageOutboxDrainServiceDependencies,
  ) {
    const options = dependencies.options;
    if (!safeWorkerIdPattern.test(options.workerId)) {
      throw new RangeError("Message outbox worker ID is invalid.");
    }
    this.#batchSize = boundedInteger(
      options.batchSize,
      25,
      1,
      100,
      "Message outbox batch size",
    );
    this.#perRecipientLimit = boundedInteger(
      options.perRecipientLimit,
      5,
      1,
      100,
      "Message outbox per-recipient limit",
    );
    this.#leaseMilliseconds = boundedInteger(
      options.leaseMilliseconds,
      60_000,
      1_000,
      15 * 60_000,
      "Message outbox claim lease",
    );
    this.#maximumAttempts = boundedInteger(
      options.maximumAttempts,
      6,
      1,
      20,
      "Message outbox attempt limit",
    );
    this.#backoffBaseMilliseconds = boundedInteger(
      options.backoffBaseMilliseconds,
      30_000,
      100,
      3_600_000,
      "Message outbox backoff base",
    );
    this.#backoffCapMilliseconds = boundedInteger(
      options.backoffCapMilliseconds,
      3_600_000,
      this.#backoffBaseMilliseconds,
      86_400_000,
      "Message outbox backoff cap",
    );
  }

  async runCycle(): Promise<MessageOutboxDrainCycleResult> {
    const counts = {
      sent: 0,
      skipped: 0,
      retrying: 0,
      failed: 0,
      lost: 0,
      errors: 0,
    };
    // Sending while required configuration is absent would classify every
    // intent as a terminal non-retryable failure — which is dropping them.
    // Deferring the pass keeps them waiting instead; a disabled or console
    // environment proceeds and produces its clean skipped records.
    const resolution = this.dependencies.delivery.resolve();
    if (
      !resolution.readiness.ready &&
      resolution.readiness.reason === "missing_configuration"
    ) {
      return { outcome: "deferred", claimed: 0, ...counts, capReached: false };
    }
    const claims = await this.dependencies.queue.claimDueBatch({
      workerId: this.dependencies.options.workerId,
      now: this.dependencies.clock.now(),
      limit: this.#batchSize,
      perRecipientLimit: this.#perRecipientLimit,
      leaseMilliseconds: this.#leaseMilliseconds,
    });
    for (const claim of claims) {
      // One poisoned intent must not starve the rest of the batch: every
      // claim settles independently, and a claim whose outcome could not be
      // recorded simply lets its lease lapse for a later pass.
      try {
        const outcome = await this.processClaim(claim, resolution);
        counts[outcome] += 1;
      } catch {
        counts.errors += 1;
      }
    }
    return {
      outcome: "drained",
      claimed: claims.length,
      ...counts,
      capReached: claims.length === this.#batchSize,
    };
  }

  private async processClaim(
    claim: ClaimedEmailOutboxMessage,
    resolution: EmailDeliveryResolution,
  ): Promise<"sent" | "skipped" | "retrying" | "failed" | "lost"> {
    const renderer = this.dependencies.renderers[claim.kind];
    if (renderer === undefined) {
      return this.recordFailure(claim, {
        provider: null,
        errorCode: "EMAIL_OUTBOX_KIND_UNKNOWN",
        errorMessage: "No renderer is registered for this message kind.",
        retryable: false,
      });
    }
    // The stored recipient is the authority delivery uses; the rendering
    // input receives it rather than carrying its own copy.
    const inputRecord =
      typeof claim.input === "object" &&
      claim.input !== null &&
      !Array.isArray(claim.input)
        ? (claim.input as Record<string, unknown>)
        : {};
    let rendered;
    try {
      rendered = renderer(
        { ...inputRecord, toEmail: claim.recipient },
        this.dependencies.origins,
      );
    } catch {
      // Renderers report failures instead of throwing; a throw is a defect
      // tied to this intent's data and will not improve on retry.
      return this.recordFailure(claim, {
        provider: null,
        errorCode: "EMAIL_OUTBOX_RENDER_CRASHED",
        errorMessage: "The message renderer crashed on this intent.",
        retryable: false,
      });
    }
    if (rendered.status !== "rendered") {
      return this.recordFailure(claim, {
        provider: null,
        errorCode: safeErrorCode(
          rendered.errorCode,
          "EMAIL_OUTBOX_RENDER_FAILED",
        ),
        errorMessage: boundedErrorMessage(rendered.reason),
        retryable: false,
      });
    }
    const result = await this.dependencies.delivery.send(rendered.message);
    if (result.status === "sent") {
      return this.dependencies.queue.recordAttemptOutcome({
        intentId: claim.intentId,
        claimToken: claim.claimToken,
        attemptNumber: claim.attemptNumber,
        occurredAt: this.dependencies.clock.now(),
        outcome: {
          status: "sent",
          provider: result.provider,
          providerMessageId: result.providerMessageId,
        },
      });
    }
    if (result.status === "skipped") {
      return this.dependencies.queue.recordAttemptOutcome({
        intentId: claim.intentId,
        claimToken: claim.claimToken,
        attemptNumber: claim.attemptNumber,
        occurredAt: this.dependencies.clock.now(),
        outcome: {
          status: "skipped",
          provider: resolution.adapter?.name ?? null,
          reason: result.reason,
        },
      });
    }
    return this.recordFailure(claim, {
      provider: result.provider,
      errorCode: safeErrorCode(result.errorCode, "EMAIL_PROVIDER_FAILED"),
      errorMessage: boundedErrorMessage(result.message),
      retryable: result.retryable,
    });
  }

  private recordFailure(
    claim: ClaimedEmailOutboxMessage,
    failure: {
      readonly provider: string | null;
      readonly errorCode: string;
      readonly errorMessage: string;
      readonly retryable: boolean;
    },
  ): Promise<"sent" | "skipped" | "retrying" | "failed" | "lost"> {
    const occurredAt = this.dependencies.clock.now();
    return this.dependencies.queue.recordAttemptOutcome({
      intentId: claim.intentId,
      claimToken: claim.claimToken,
      attemptNumber: claim.attemptNumber,
      occurredAt,
      outcome: {
        status: "failed",
        provider: failure.provider,
        errorCode: failure.errorCode,
        errorMessage: failure.errorMessage,
        retryable: failure.retryable,
        retryAt: new Date(
          occurredAt.getTime() +
            emailOutboxBackoffMilliseconds({
              attempt: claim.attemptNumber,
              baseMilliseconds: this.#backoffBaseMilliseconds,
              capMilliseconds: this.#backoffCapMilliseconds,
            }),
        ),
        maximumAttempts: this.#maximumAttempts,
      },
    });
  }
}
