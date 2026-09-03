import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  EmailDeliveryResult,
  RenderedEmailMessage,
} from "@packscout/contracts";
import type {
  EmailDeliveryAdapter,
} from "../email-delivery/adapter.ts";
import type { EmailDeliveryResolution } from "../email-delivery/delivery-service.ts";
import {
  MessageOutboxDrainService,
  emailOutboxBackoffMilliseconds,
  type ClaimedEmailOutboxMessage,
  type EmailMessageOutboxDrainQueue,
} from "./drain-service.ts";
import { createEmailMessageOutboxRenderers } from "./renderers.ts";

const now = new Date("2026-08-22T12:00:00.000Z");
const clock = { now: () => now };
const origins = {
  productOrigin: "https://packscout.example",
  adminOrigin: "https://admin.packscout.example",
};

const postmarkAdapter = { name: "postmark" } as EmailDeliveryAdapter;

function readyResolution(): EmailDeliveryResolution {
  return {
    mode: { kind: "auto" },
    adapter: postmarkAdapter,
    productionLike: false,
    readiness: { ready: true },
  };
}

function claim(
  overrides: Partial<ClaimedEmailOutboxMessage> = {},
): ClaimedEmailOutboxMessage {
  return {
    intentId: "11111111-1111-4111-8111-111111111111",
    kind: "welcome",
    input: {},
    recipient: "admitted@example.test",
    claimToken: "22222222-2222-4222-8222-222222222222",
    attemptNumber: 1,
    ...overrides,
  };
}

type OutcomeCall = Parameters<
  EmailMessageOutboxDrainQueue["recordAttemptOutcome"]
>[0];
type ClaimCall = Parameters<EmailMessageOutboxDrainQueue["claimDueBatch"]>[0];

class FakeQueue implements EmailMessageOutboxDrainQueue {
  claims: readonly ClaimedEmailOutboxMessage[] = [];
  claimCalls: ClaimCall[] = [];
  outcomeCalls: OutcomeCall[] = [];
  scriptedOutcomes = new Map<
    string,
    "sent" | "skipped" | "retrying" | "failed" | "lost"
  >();
  throwOnIntent: string | null = null;

  async claimDueBatch(input: ClaimCall) {
    this.claimCalls.push(input);
    return this.claims;
  }

  async recordAttemptOutcome(input: OutcomeCall) {
    if (input.intentId === this.throwOnIntent) {
      throw new Error("durable store unavailable");
    }
    this.outcomeCalls.push(input);
    const scripted = this.scriptedOutcomes.get(input.intentId);
    if (scripted) return scripted;
    if (input.outcome.status === "sent") return "sent";
    if (input.outcome.status === "skipped") return "skipped";
    return input.outcome.retryable &&
      input.outcome.maximumAttempts > 1
      ? "retrying"
      : "failed";
  }
}

class FakeDelivery {
  resolution: EmailDeliveryResolution = readyResolution();
  results: EmailDeliveryResult[] = [];
  sends: RenderedEmailMessage[] = [];

  resolve(): EmailDeliveryResolution {
    return this.resolution;
  }

  async send(message: RenderedEmailMessage): Promise<EmailDeliveryResult> {
    this.sends.push(message);
    const next = this.results.shift();
    if (!next) throw new Error("unscripted send");
    return next;
  }
}

function drain(
  queue: FakeQueue,
  delivery: FakeDelivery,
  options: Partial<ConstructorParameters<typeof MessageOutboxDrainService>[0]["options"]> = {},
  renderers = createEmailMessageOutboxRenderers(),
): MessageOutboxDrainService {
  return new MessageOutboxDrainService({
    queue,
    delivery,
    renderers,
    origins,
    clock,
    options: { workerId: "worker:test:1", ...options },
  });
}

test("a due intent renders through the catalogue and delivers through the boundary", async () => {
  const queue = new FakeQueue();
  queue.claims = [claim()];
  const delivery = new FakeDelivery();
  delivery.results = [
    { status: "sent", provider: "postmark", providerMessageId: "pm-1" },
  ];
  const result = await drain(queue, delivery, {
    batchSize: 10,
    perRecipientLimit: 3,
    leaseMilliseconds: 45_000,
  }).runCycle();
  assert.deepEqual(result, {
    outcome: "drained",
    claimed: 1,
    sent: 1,
    skipped: 0,
    retrying: 0,
    failed: 0,
    lost: 0,
    errors: 0,
    capReached: false,
  });
  assert.deepEqual(queue.claimCalls, [
    {
      workerId: "worker:test:1",
      now,
      limit: 10,
      perRecipientLimit: 3,
      leaseMilliseconds: 45_000,
    },
  ]);
  // The stored recipient is the delivery authority for the rendered message.
  assert.equal(delivery.sends[0]?.toEmail, "admitted@example.test");
  assert.equal(delivery.sends[0]?.kind, "welcome");
  assert.deepEqual(queue.outcomeCalls[0], {
    intentId: claim().intentId,
    claimToken: claim().claimToken,
    attemptNumber: 1,
    occurredAt: now,
    outcome: { status: "sent", provider: "postmark", providerMessageId: "pm-1" },
  });
});

test("a rendering failure is terminal: recorded non-retryable and never sent", async () => {
  const queue = new FakeQueue();
  queue.claims = [
    claim({ kind: "operational_alert", input: { severity: "loud" } }),
  ];
  const delivery = new FakeDelivery();
  const result = await drain(queue, delivery).runCycle();
  assert.equal(result.failed, 1);
  assert.equal(delivery.sends.length, 0, "rendering failures never reach a provider");
  const outcome = queue.outcomeCalls[0]?.outcome;
  assert.equal(outcome?.status, "failed");
  if (outcome?.status === "failed") {
    assert.equal(outcome.errorCode, "EMAIL_MESSAGE_INPUT_INVALID");
    assert.equal(outcome.retryable, false);
    assert.equal(outcome.provider, null);
  }
});

test("an unknown stored kind is a terminal failure rather than a crash or retry", async () => {
  const queue = new FakeQueue();
  queue.claims = [claim({ kind: "mystery_kind" })];
  const delivery = new FakeDelivery();
  const result = await drain(queue, delivery).runCycle();
  assert.equal(result.failed, 1);
  const outcome = queue.outcomeCalls[0]?.outcome;
  assert.equal(outcome?.status, "failed");
  if (outcome?.status === "failed") {
    assert.equal(outcome.errorCode, "EMAIL_OUTBOX_KIND_UNKNOWN");
    assert.equal(outcome.retryable, false);
  }
});

test("one poisoned intent cannot starve the rest of the pass", async () => {
  const crashing = claim({
    intentId: "33333333-3333-4333-8333-333333333333",
    kind: "welcome",
  });
  const healthy = claim();
  const queue = new FakeQueue();
  queue.claims = [crashing, healthy];
  const delivery = new FakeDelivery();
  delivery.results = [
    { status: "sent", provider: "postmark", providerMessageId: null },
  ];
  const renderers = {
    ...createEmailMessageOutboxRenderers(),
    welcome: (
      input: unknown,
      renderOrigins: Parameters<
        ReturnType<typeof createEmailMessageOutboxRenderers>[string]
      >[1],
    ) => {
      if (
        (input as { toEmail?: string }).toEmail === crashing.recipient &&
        (input as { poison?: boolean }).poison === true
      ) {
        throw new Error("renderer defect");
      }
      return createEmailMessageOutboxRenderers().welcome!(input, renderOrigins);
    },
  };
  queue.claims = [
    { ...crashing, input: { poison: true } },
    healthy,
  ];
  const result = await drain(queue, delivery, {}, renderers).runCycle();
  // The crashing renderer became a terminal failure; the healthy intent in
  // the same pass still delivered.
  assert.equal(result.failed, 1);
  assert.equal(result.sent, 1);
  const poisoned = queue.outcomeCalls.find(
    (call) => call.intentId === crashing.intentId,
  );
  assert.equal(poisoned?.outcome.status, "failed");
  if (poisoned?.outcome.status === "failed") {
    assert.equal(poisoned.outcome.errorCode, "EMAIL_OUTBOX_RENDER_CRASHED");
    assert.equal(poisoned.outcome.retryable, false);
  }

  // Even a claim whose outcome cannot be recorded only costs itself: the
  // next claim still settles, and the wedged claim's lease lapses.
  const failingStore = new FakeQueue();
  failingStore.claims = [crashing, healthy];
  failingStore.throwOnIntent = crashing.intentId;
  const secondDelivery = new FakeDelivery();
  secondDelivery.results = [
    { status: "sent", provider: "postmark", providerMessageId: null },
    { status: "sent", provider: "postmark", providerMessageId: null },
  ];
  const secondResult = await drain(failingStore, secondDelivery).runCycle();
  assert.equal(secondResult.errors, 1);
  assert.equal(secondResult.sent, 1);
});

test("retryable delivery failures back off exponentially to the cap", async () => {
  for (const [attemptNumber, expectedDelay] of [
    [1, 30_000],
    [3, 120_000],
    [8, 3_600_000],
  ] as const) {
    const queue = new FakeQueue();
    queue.claims = [claim({ attemptNumber })];
    const delivery = new FakeDelivery();
    delivery.results = [
      {
        status: "failed",
        provider: "postmark",
        errorCode: "EMAIL_POSTMARK_TRANSPORT_FAILED",
        message: "Connection reset.",
        retryable: true,
      },
    ];
    const result = await drain(queue, delivery, {
      maximumAttempts: 10,
      backoffBaseMilliseconds: 30_000,
      backoffCapMilliseconds: 3_600_000,
    }).runCycle();
    assert.equal(result.retrying, 1);
    const outcome = queue.outcomeCalls[0]?.outcome;
    assert.equal(outcome?.status, "failed");
    if (outcome?.status === "failed") {
      assert.equal(outcome.retryable, true);
      assert.equal(outcome.maximumAttempts, 10);
      assert.deepEqual(
        outcome.retryAt,
        new Date(now.getTime() + expectedDelay),
        `attempt ${attemptNumber} backs off ${expectedDelay}ms`,
      );
    }
  }
});

test("the attempt limit and terminal classification pass through to the durable queue", async () => {
  const queue = new FakeQueue();
  queue.claims = [claim({ attemptNumber: 6 })];
  queue.scriptedOutcomes.set(claim().intentId, "failed");
  const delivery = new FakeDelivery();
  delivery.results = [
    {
      status: "failed",
      provider: "postmark",
      errorCode: "EMAIL_POSTMARK_ERROR_406",
      message: "Recipient rejected.",
      retryable: false,
    },
  ];
  const result = await drain(queue, delivery).runCycle();
  assert.equal(result.failed, 1);
  const outcome = queue.outcomeCalls[0]?.outcome;
  if (outcome?.status === "failed") {
    assert.equal(outcome.retryable, false);
    assert.equal(outcome.errorCode, "EMAIL_POSTMARK_ERROR_406");
  }
});

test("skipped outcomes are recorded as skipped with their reason, not failures", async () => {
  const queue = new FakeQueue();
  queue.claims = [claim()];
  const delivery = new FakeDelivery();
  delivery.resolution = {
    mode: { kind: "console" },
    adapter: null,
    productionLike: false,
    readiness: { ready: true },
  };
  delivery.results = [{ status: "skipped", reason: "console_mode" }];
  const result = await drain(queue, delivery).runCycle();
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 0);
  const outcome = queue.outcomeCalls[0]?.outcome;
  assert.equal(outcome?.status, "skipped");
  if (outcome?.status === "skipped") {
    assert.equal(outcome.reason, "console_mode");
    assert.equal(outcome.provider, null);
  }
});

test("an unconfigured required delivery defers the pass; the intents wait unclaimed", async () => {
  const queue = new FakeQueue();
  queue.claims = [claim()];
  const delivery = new FakeDelivery();
  delivery.resolution = {
    mode: { kind: "auto" },
    adapter: postmarkAdapter,
    productionLike: true,
    readiness: { ready: false, reason: "missing_configuration" },
  };
  const result = await drain(queue, delivery).runCycle();
  assert.equal(result.outcome, "deferred");
  assert.equal(result.claimed, 0);
  assert.equal(queue.claimCalls.length, 0, "nothing is claimed while deferred");
  assert.equal(queue.outcomeCalls.length, 0, "nothing is recorded while deferred");
  assert.equal(delivery.sends.length, 0);
});

test("a deliberately disabled production environment still drains into skipped records", async () => {
  const queue = new FakeQueue();
  queue.claims = [claim()];
  const delivery = new FakeDelivery();
  delivery.resolution = {
    mode: { kind: "disabled" },
    adapter: null,
    productionLike: true,
    readiness: { ready: false, reason: "delivery_disabled" },
  };
  delivery.results = [{ status: "skipped", reason: "delivery_disabled" }];
  const result = await drain(queue, delivery).runCycle();
  assert.equal(result.outcome, "drained");
  assert.equal(result.skipped, 1);
});

test("a lost claim is counted and neither retried nor recorded twice by this pass", async () => {
  const queue = new FakeQueue();
  queue.claims = [claim()];
  queue.scriptedOutcomes.set(claim().intentId, "lost");
  const delivery = new FakeDelivery();
  delivery.results = [
    { status: "sent", provider: "postmark", providerMessageId: "pm-9" },
  ];
  const result = await drain(queue, delivery).runCycle();
  assert.equal(result.lost, 1);
  assert.equal(queue.outcomeCalls.length, 1);
});

test("a full batch reports its cap so the runtime can keep draining", async () => {
  const queue = new FakeQueue();
  queue.claims = [
    claim(),
    claim({ intentId: "44444444-4444-4444-8444-444444444444" }),
  ];
  const delivery = new FakeDelivery();
  delivery.results = [
    { status: "sent", provider: "postmark", providerMessageId: null },
    { status: "sent", provider: "postmark", providerMessageId: null },
  ];
  const result = await drain(queue, delivery, { batchSize: 2 }).runCycle();
  assert.equal(result.capReached, true);
});

test("provider error text is bounded and codes are normalized before recording", async () => {
  const queue = new FakeQueue();
  queue.claims = [claim()];
  const delivery = new FakeDelivery();
  delivery.results = [
    {
      status: "failed",
      provider: "postmark",
      errorCode: "not a stable code",
      message: "x".repeat(500),
      retryable: true,
    },
  ];
  await drain(queue, delivery).runCycle();
  const outcome = queue.outcomeCalls[0]?.outcome;
  assert.equal(outcome?.status, "failed");
  if (outcome?.status === "failed") {
    assert.equal(outcome.errorCode, "EMAIL_PROVIDER_FAILED");
    assert.equal(outcome.errorMessage.length, 200);
  }
});

test("drain settings are bounded at construction", () => {
  const queue = new FakeQueue();
  const delivery = new FakeDelivery();
  assert.throws(() => drain(queue, delivery, { workerId: "bad id" }), RangeError);
  assert.throws(() => drain(queue, delivery, { batchSize: 0 }), RangeError);
  assert.throws(() => drain(queue, delivery, { batchSize: 101 }), RangeError);
  assert.throws(
    () => drain(queue, delivery, { leaseMilliseconds: 999 }),
    RangeError,
  );
  assert.throws(
    () => drain(queue, delivery, { maximumAttempts: 21 }),
    RangeError,
  );
  assert.throws(
    () =>
      drain(queue, delivery, {
        backoffBaseMilliseconds: 60_000,
        backoffCapMilliseconds: 30_000,
      }),
    RangeError,
    "the cap can never undercut the base",
  );
});

test("the backoff schedule doubles from the base and never exceeds the cap", () => {
  const schedule = [1, 2, 3, 4, 5, 6].map((attempt) =>
    emailOutboxBackoffMilliseconds({
      attempt,
      baseMilliseconds: 30_000,
      capMilliseconds: 600_000,
    }),
  );
  assert.deepEqual(schedule, [
    30_000, 60_000, 120_000, 240_000, 480_000, 600_000,
  ]);
  assert.equal(
    emailOutboxBackoffMilliseconds({
      attempt: 0,
      baseMilliseconds: 30_000,
      capMilliseconds: 600_000,
    }),
    30_000,
    "attempts below one clamp to the base delay",
  );
});
