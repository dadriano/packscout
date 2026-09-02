import assert from "node:assert/strict";
import test from "node:test";
import type {
  PromotionJobLivenessConditionDelivery,
} from "@packscout/database";
import type {
  PromotionJobEvaluatorWatchdogResponse,
} from "@packscout/services";
import {
  PromotionJobSystemConditionWebhook,
} from "./promotion-job-system-condition-webhook.ts";

const conditionId = "30000000-0000-4000-8000-000000000001";
const eventId = "40000000-0000-4000-8000-000000000001";
const organizationId = "10000000-0000-4000-8000-000000000001";
const providerId = "20000000-0000-4000-8000-000000000001";
const evaluatedAt = new Date("2026-09-01T12:03:00.001Z");
const token = new Uint8Array(32).fill(7);
const encodedToken = Buffer.from(token).toString("base64");

type SystemDelivery = PromotionJobLivenessConditionDelivery & Readonly<{
  scope: "system";
}>;

function delivery(
  overrides: Partial<PromotionJobLivenessConditionDelivery> = {},
): SystemDelivery {
  return {
    conditionId,
    eventId,
    action: "raise",
    scope: "system",
    subject: "manifest_schedule",
    organizationId: null,
    providerId: null,
    scheduleEpoch: 1n,
    missedWindowCount: 3n,
    anchorLastScheduledCheckinAt: null,
    evaluatedAt,
    attemptCount: 0,
    ...overrides,
  } as SystemDelivery;
}

function watchdog(
  overrides: Partial<PromotionJobEvaluatorWatchdogResponse> = {},
): PromotionJobEvaluatorWatchdogResponse {
  return {
    lifecycle: "active",
    health: "healthy",
    evaluatorEpoch: "1",
    missedWindowCount: "1",
    evaluatedAt: "2026-09-01T12:01:00.001Z",
    lastSuccessfulEvaluationAt: "2026-09-01T12:00:00.000Z",
    evaluatedThrough: "2026-09-01T12:00:00.000Z",
    rosterDigest: "a".repeat(64),
    expectedCount: 3,
    reachableCount: 2,
    unavailableCount: 1,
    ...overrides,
  };
}

function acknowledgement(): Response {
  return new Response(JSON.stringify({ state: "delivered" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function webhook(fetch: typeof globalThis.fetch) {
  return new PromotionJobSystemConditionWebhook({
    baseUrl: "https://system-conditions.example",
    bearerToken: token,
    timeoutMilliseconds: 1_000,
    fetch,
  });
}

test("manifest delivery authenticates only in the header and emits a redacted fixed payload", async () => {
  let capturedUrl = "";
  let captured: RequestInit | undefined;
  const client = webhook((async (input, init) => {
    capturedUrl = String(input);
    captured = init;
    return acknowledgement();
  }) as typeof globalThis.fetch);
  const protectedMarker = "raw-database-evidence-must-not-leave";
  const polluted = Object.assign(delivery(), {
    organizationIdentifier: organizationId,
    providerIdentifier: providerId,
    databaseTarget: "postgresql://secret.example/private",
    rawEvidence: protectedMarker,
  });

  assert.deepEqual(await client.publish(polluted), { state: "delivered" });
  assert.equal(
    capturedUrl,
    "https://system-conditions.example/v1/promotion-jobs/system-conditions",
  );
  assert.equal(captured?.method, "POST");
  assert.equal(captured?.redirect, "error");
  const headers = new Headers(captured?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${encodedToken}`);
  assert.equal(headers.get("content-type"), "application/json");
  const payload = JSON.parse(String(captured?.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), [
    "action",
    "conditionKeySha256",
    "evaluatedAt",
    "eventKeySha256",
    "missedWindowCount",
    "scheduleEpoch",
    "schemaVersion",
    "scope",
    "subject",
  ]);
  assert.deepEqual({
    schemaVersion: payload.schemaVersion,
    scope: payload.scope,
    subject: payload.subject,
    action: payload.action,
    scheduleEpoch: payload.scheduleEpoch,
    missedWindowCount: payload.missedWindowCount,
    evaluatedAt: payload.evaluatedAt,
  }, {
    schemaVersion: 1,
    scope: "system",
    subject: "manifest_schedule",
    action: "raise",
    scheduleEpoch: "1",
    missedWindowCount: "3",
    evaluatedAt: evaluatedAt.toISOString(),
  });
  assert.match(String(payload.conditionKeySha256), /^[0-9a-f]{64}$/u);
  assert.match(String(payload.eventKeySha256), /^[0-9a-f]{64}$/u);
  const body = String(captured?.body);
  for (const forbidden of [
    encodedToken,
    conditionId,
    eventId,
    organizationId,
    providerId,
    "postgresql://",
    protectedMarker,
  ]) assert.equal(body.includes(forbidden), false, forbidden);
});

test("only an exact system manifest subject is admitted before fetch", async () => {
  let requests = 0;
  const client = webhook((async () => {
    requests += 1;
    return acknowledgement();
  }) as typeof globalThis.fetch);
  const malformed = [
    delivery({ scope: "provider", subject: "provider_schedule" }),
    delivery({ subject: "provider_schedule" }),
    delivery({ organizationId }),
    delivery({ providerId }),
    delivery({ conditionId: "not-a-condition" }),
  ];
  for (const item of malformed) {
    assert.deepEqual(await client.publish(item), {
      state: "retryable_failure",
      failureCode: "PROMOTION_JOB_SYSTEM_CONDITION_SCOPE_INVALID",
    });
  }
  assert.equal(requests, 0);
});

test("configuration accepts only an HTTPS origin and bounded credential bytes", () => {
  const create = (baseUrl: string, bearerToken: Uint8Array = token) =>
    new PromotionJobSystemConditionWebhook({
      baseUrl,
      bearerToken,
      timeoutMilliseconds: 1_000,
      fetch: (async () => acknowledgement()) as typeof globalThis.fetch,
    });
  for (const invalidUrl of [
    "http://system-conditions.example",
    "https://user:secret@system-conditions.example",
    "https://system-conditions.example/tenant/one",
    "https://system-conditions.example?provider=one",
    "not a URL",
  ]) {
    assert.throws(() => create(invalidUrl), {
      code: "PROMOTION_JOB_SYSTEM_CONDITION_CONFIGURATION_INVALID",
      message:
        "Promotion job system condition webhook configuration is invalid.",
    });
  }
  assert.throws(() => create(
    "https://system-conditions.example",
    new Uint8Array(31),
  ), { code: "PROMOTION_JOB_SYSTEM_CONDITION_CONFIGURATION_INVALID" });
});

test("redirect, HTTP, malformed, and oversized responses collapse to one safe retry", async () => {
  const unavailable = {
    state: "retryable_failure",
    failureCode: "PROMOTION_JOB_SYSTEM_CONDITION_WEBHOOK_UNAVAILABLE",
  };
  const redirected = webhook((async (_input, init) => {
    assert.equal(init?.redirect, "error");
    throw new TypeError("redirect included protected upstream URL");
  }) as typeof globalThis.fetch);
  assert.deepEqual(await redirected.publish(delivery()), unavailable);

  const rejected = webhook((async () => new Response(
    "provider and database details in an upstream error",
    { status: 503 },
  )) as typeof globalThis.fetch);
  assert.deepEqual(await rejected.publish(delivery()), unavailable);

  const malformed = webhook((async () => new Response(
    JSON.stringify({ state: "delivered", rawEvidence: "protected" }),
    { status: 200 },
  )) as typeof globalThis.fetch);
  assert.deepEqual(await malformed.publish(delivery()), unavailable);

  const declaredOversize = webhook((async () => new Response("", {
    status: 200,
    headers: { "content-length": "4097" },
  })) as typeof globalThis.fetch);
  assert.deepEqual(await declaredOversize.publish(delivery()), unavailable);

  let cancelled = false;
  const streamedOversize = webhook((async () => new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3_000));
        controller.enqueue(new Uint8Array(3_000));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { status: 200 },
  )) as typeof globalThis.fetch);
  assert.deepEqual(await streamedOversize.publish(delivery()), unavailable);
  assert.equal(cancelled, true);
});

test("timeout aborts the request and returns no underlying failure detail", async () => {
  let aborted = false;
  const client = new PromotionJobSystemConditionWebhook({
    baseUrl: "https://system-conditions.example",
    bearerToken: token,
    timeoutMilliseconds: 5,
    fetch: ((_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("database topology and credential detail"));
      }, { once: true });
    })) as typeof globalThis.fetch,
  });
  assert.deepEqual(await client.publish(delivery()), {
    state: "retryable_failure",
    failureCode: "PROMOTION_JOB_SYSTEM_CONDITION_WEBHOOK_TIMEOUT",
  });
  assert.equal(aborted, true);
});

test("watchdog observations use a separate fixed system-only projection", async () => {
  let capturedUrl = "";
  let capturedBody = "";
  const client = webhook((async (input, init) => {
    capturedUrl = String(input);
    capturedBody = String(init?.body);
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch);
  const polluted = Object.assign(watchdog(), {
    providerId,
    organizationId,
    databaseTarget: "postgresql://protected",
    rawEvidence: "raw-watchdog-evidence",
  });

  assert.deepEqual(await client.publishEvaluatorObservation(polluted), {
    state: "delivered",
  });
  assert.equal(
    capturedUrl,
    "https://system-conditions.example/v1/promotion-jobs/evaluator-observations",
  );
  const payload = JSON.parse(capturedBody) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), [
    "evaluatedAt",
    "evaluatedThrough",
    "evaluatorEpoch",
    "expectedCount",
    "health",
    "lastSuccessfulEvaluationAt",
    "lifecycle",
    "missedWindowCount",
    "reachableCount",
    "rosterDigest",
    "schemaVersion",
    "scope",
    "subject",
    "unavailableCount",
  ]);
  assert.equal(payload.scope, "system");
  assert.equal(payload.subject, "promotion_job_evaluator_watchdog");
  for (const forbidden of [
    encodedToken,
    organizationId,
    providerId,
    "postgresql://",
    "raw-watchdog-evidence",
    "tenant",
    "databaseTarget",
  ]) assert.equal(capturedBody.includes(forbidden), false, forbidden);

  assert.deepEqual(await client.publishEvaluatorObservation(watchdog({
    health: "healthy",
    missedWindowCount: "3",
  })), {
    state: "retryable_failure",
    failureCode: "PROMOTION_JOB_EVALUATOR_OBSERVATION_INVALID",
  });
});
