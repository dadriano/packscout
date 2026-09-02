import { createHash } from "node:crypto";
import type {
  PromotionJobLivenessConditionDelivery,
} from "@packscout/database";
import type {
  PromotionJobEvaluatorWatchdogResponse,
} from "@packscout/services";
import type {
  PromotionJobSystemConditionSink,
} from "./promotion-job-liveness-composition.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UNSIGNED_BIGINT_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/u;
const MAXIMUM_SIGNED_BIGINT = 9_223_372_036_854_775_807n;
const MAXIMUM_WEBHOOK_BODY_BYTES = 4 * 1_024;
const SYSTEM_CONDITION_PATH = "/v1/promotion-jobs/system-conditions";
const EVALUATOR_OBSERVATION_PATH =
  "/v1/promotion-jobs/evaluator-observations";

export type PromotionJobSystemConditionWebhookResult =
  | Readonly<{ state: "delivered" }>
  | Readonly<{
      state: "retryable_failure";
      failureCode: string;
    }>;

export interface PromotionJobEvaluatorObservationSink {
  publishEvaluatorObservation(
    observation: PromotionJobEvaluatorWatchdogResponse,
  ): Promise<PromotionJobSystemConditionWebhookResult>;
}

export interface PromotionJobSystemConditionWebhookOptions {
  /** HTTPS origin only. Webhook paths are fixed by this adapter. */
  readonly baseUrl: string;
  /** Raw credential bytes. They are copied and encoded only for the header. */
  readonly bearerToken: Uint8Array;
  readonly timeoutMilliseconds: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export class PromotionJobSystemConditionWebhookConfigurationError
  extends Error {
  readonly code = "PROMOTION_JOB_SYSTEM_CONDITION_CONFIGURATION_INVALID";

  constructor() {
    super("Promotion job system condition webhook configuration is invalid.");
    this.name = "PromotionJobSystemConditionWebhookConfigurationError";
  }
}

function retryable(failureCode: string): PromotionJobSystemConditionWebhookResult {
  return { state: "retryable_failure", failureCode };
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validUnsignedBigint(value: unknown): value is string {
  return typeof value === "string"
    && UNSIGNED_BIGINT_PATTERN.test(value)
    && BigInt(value) <= MAXIMUM_SIGNED_BIGINT;
}

function validCount(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function webhookOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new PromotionJobSystemConditionWebhookConfigurationError();
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PromotionJobSystemConditionWebhookConfigurationError();
  }
  if (
    parsed.protocol !== "https:"
    || parsed.origin === "null"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
  ) throw new PromotionJobSystemConditionWebhookConfigurationError();
  return parsed.origin;
}

function identityDigest(kind: "condition" | "event", value: string): string {
  return createHash("sha256")
    .update("packscout:promotion-job-system-condition:v1\0", "utf8")
    .update(kind, "utf8")
    .update("\0", "utf8")
    .update(value.toLowerCase(), "utf8")
    .digest("hex");
}

function manifestPayload(
  delivery: PromotionJobLivenessConditionDelivery & Readonly<{
    scope: "system";
  }>,
): Readonly<Record<string, unknown>> | null {
  if (
    delivery.scope !== "system"
    || delivery.subject !== "manifest_schedule"
    || delivery.organizationId !== null
    || delivery.providerId !== null
    || !UUID_PATTERN.test(delivery.conditionId)
    || !UUID_PATTERN.test(delivery.eventId)
    || (delivery.action !== "raise" && delivery.action !== "recover")
    || delivery.scheduleEpoch < 1n
    || delivery.scheduleEpoch > MAXIMUM_SIGNED_BIGINT
    || delivery.missedWindowCount < 0n
    || delivery.missedWindowCount > MAXIMUM_SIGNED_BIGINT
    || !validDate(delivery.evaluatedAt)
    || !Number.isSafeInteger(delivery.attemptCount)
    || delivery.attemptCount < 0
  ) return null;
  return {
    schemaVersion: 1,
    scope: "system",
    subject: "manifest_schedule",
    action: delivery.action,
    conditionKeySha256: identityDigest("condition", delivery.conditionId),
    eventKeySha256: identityDigest("event", delivery.eventId),
    scheduleEpoch: delivery.scheduleEpoch.toString(),
    missedWindowCount: delivery.missedWindowCount.toString(),
    evaluatedAt: delivery.evaluatedAt.toISOString(),
  };
}

function validWatchdogCounts(
  observation: PromotionJobEvaluatorWatchdogResponse,
): boolean {
  const counts = [
    observation.expectedCount,
    observation.reachableCount,
    observation.unavailableCount,
  ];
  if (counts.every((value) => value === null)) return true;
  return counts.every(validCount)
    && observation.expectedCount! >= 1
    && observation.reachableCount! + observation.unavailableCount!
      === observation.expectedCount!;
}

function watchdogPayload(
  observation: PromotionJobEvaluatorWatchdogResponse,
): Readonly<Record<string, unknown>> | null {
  const lifecycle = observation.lifecycle;
  const health = observation.health;
  if (
    !["pending_activation", "active", "paused"].includes(lifecycle)
    || !["inactive", "healthy", "overdue", "alerting"].includes(health)
    || !validUnsignedBigint(observation.evaluatorEpoch)
    || !validUnsignedBigint(observation.missedWindowCount)
    || !validIsoDate(observation.evaluatedAt)
    || !validWatchdogCounts(observation)
  ) return null;
  const missed = BigInt(observation.missedWindowCount);
  const expectedHealth = lifecycle !== "active"
    ? "inactive"
    : missed >= 3n
      ? "alerting"
      : missed === 2n
        ? "overdue"
        : "healthy";
  const successValues = [
    observation.lastSuccessfulEvaluationAt,
    observation.evaluatedThrough,
    observation.rosterDigest,
    observation.expectedCount,
  ];
  const noSuccess = successValues.every((value) => value === null);
  const completeSuccess = successValues.every((value) => value !== null);
  if (
    health !== expectedHealth
    || (!noSuccess && !completeSuccess)
    || (observation.lastSuccessfulEvaluationAt !== null
      && !validIsoDate(observation.lastSuccessfulEvaluationAt))
    || (observation.evaluatedThrough !== null
      && !validIsoDate(observation.evaluatedThrough))
    || (observation.rosterDigest !== null
      && !SHA256_PATTERN.test(observation.rosterDigest))
    || (lifecycle === "pending_activation"
      && (observation.evaluatorEpoch !== "0"
        || observation.missedWindowCount !== "0"
        || !noSuccess))
    || (lifecycle !== "pending_activation" && !completeSuccess)
  ) return null;
  return {
    schemaVersion: 1,
    scope: "system",
    subject: "promotion_job_evaluator_watchdog",
    lifecycle,
    health,
    evaluatorEpoch: observation.evaluatorEpoch,
    missedWindowCount: observation.missedWindowCount,
    evaluatedAt: observation.evaluatedAt,
    lastSuccessfulEvaluationAt: observation.lastSuccessfulEvaluationAt,
    evaluatedThrough: observation.evaluatedThrough,
    rosterDigest: observation.rosterDigest,
    expectedCount: observation.expectedCount,
    reachableCount: observation.reachableCount,
    unavailableCount: observation.unavailableCount,
  };
}

async function boundedAcknowledgement(response: Response): Promise<boolean> {
  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader !== null) {
    if (!/^(?:0|[1-9][0-9]{0,4})$/u.test(declaredHeader)) return false;
    if (Number(declaredHeader) > MAXIMUM_WEBHOOK_BODY_BYTES) return false;
  }
  if (response.body === null) return response.status === 204;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAXIMUM_WEBHOOK_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return false;
    }
    chunks.push(next.value);
  }
  if (length === 0) return response.status === 204;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    return false;
  }
  return decoded !== null
    && typeof decoded === "object"
    && !Array.isArray(decoded)
    && Object.keys(decoded).length === 1
    && (decoded as Record<string, unknown>).state === "delivered";
}

/**
 * Least-privilege outbound adapter for central system conditions. It never
 * forwards tenant/provider identity, database topology, or raw condition
 * evidence. Webhook failures are reduced to stable caller-safe retry codes.
 */
export class PromotionJobSystemConditionWebhook
implements PromotionJobSystemConditionSink,
  PromotionJobEvaluatorObservationSink {
  readonly #origin: string;
  readonly #authorization: string;
  readonly #timeoutMilliseconds: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: PromotionJobSystemConditionWebhookOptions) {
    this.#origin = webhookOrigin(options.baseUrl);
    if (
      !(options.bearerToken instanceof Uint8Array)
      || options.bearerToken.byteLength < 32
      || options.bearerToken.byteLength > 128
      || !Number.isInteger(options.timeoutMilliseconds)
      || options.timeoutMilliseconds < 1
      || options.timeoutMilliseconds > 60_000
    ) throw new PromotionJobSystemConditionWebhookConfigurationError();
    const token = Uint8Array.from(options.bearerToken);
    this.#authorization = `Bearer ${Buffer.from(token).toString("base64")}`;
    this.#timeoutMilliseconds = options.timeoutMilliseconds;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  publish(
    delivery: PromotionJobLivenessConditionDelivery & Readonly<{
      scope: "system";
    }>,
    input?: Readonly<{ deadlineAt: number }>,
  ): Promise<PromotionJobSystemConditionWebhookResult> {
    const payload = manifestPayload(delivery);
    return payload === null
      ? Promise.resolve(retryable(
          "PROMOTION_JOB_SYSTEM_CONDITION_SCOPE_INVALID",
        ))
      : this.send(SYSTEM_CONDITION_PATH, payload, input?.deadlineAt);
  }

  publishEvaluatorObservation(
    observation: PromotionJobEvaluatorWatchdogResponse,
  ): Promise<PromotionJobSystemConditionWebhookResult> {
    const payload = watchdogPayload(observation);
    return payload === null
      ? Promise.resolve(retryable(
          "PROMOTION_JOB_EVALUATOR_OBSERVATION_INVALID",
        ))
      : this.send(EVALUATOR_OBSERVATION_PATH, payload);
  }

  private async send(
    path: string,
    payload: Readonly<Record<string, unknown>>,
    deadlineAt?: number,
  ): Promise<PromotionJobSystemConditionWebhookResult> {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, "utf8") > MAXIMUM_WEBHOOK_BODY_BYTES) {
      return retryable("PROMOTION_JOB_SYSTEM_CONDITION_PAYLOAD_INVALID");
    }
    const startedAt = this.#now();
    const remainingMilliseconds = deadlineAt === undefined
      ? this.#timeoutMilliseconds
      : Math.floor(deadlineAt - startedAt);
    if (
      !Number.isSafeInteger(startedAt)
      || (deadlineAt !== undefined && !Number.isSafeInteger(deadlineAt))
      || remainingMilliseconds <= 0
    ) {
      return retryable("PROMOTION_JOB_SYSTEM_CONDITION_WEBHOOK_TIMEOUT");
    }
    const timeoutMilliseconds = Math.min(
      this.#timeoutMilliseconds,
      remainingMilliseconds,
    );
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMilliseconds);
    try {
      const response = await this.#fetch(`${this.#origin}${path}`, {
        method: "POST",
        headers: {
          authorization: this.#authorization,
          "content-type": "application/json",
        },
        body,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok || !await boundedAcknowledgement(response)) {
        return retryable(
          "PROMOTION_JOB_SYSTEM_CONDITION_WEBHOOK_UNAVAILABLE",
        );
      }
      return { state: "delivered" };
    } catch {
      return retryable(timedOut
        ? "PROMOTION_JOB_SYSTEM_CONDITION_WEBHOOK_TIMEOUT"
        : "PROMOTION_JOB_SYSTEM_CONDITION_WEBHOOK_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }
  }
}
