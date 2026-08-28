import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MESSAGE_DELIVERY_PAGE_SIZE,
  listMessageDeliveriesRequestSchema,
  messageDeliveryAdminErrorCodes,
  messageDeliveryCountsRequestSchema,
  messageDeliveryDetailRequestSchema,
  retryMessageDeliveryRequestSchema,
  type MessageDeliveryAttemptRow,
  type MessageDeliveryIntentRow,
} from "./message-delivery.ts";

test("delivery listing requests stay bounded, closed, and body-shaped", () => {
  const defaulted = listMessageDeliveriesRequestSchema.parse({});
  assert.equal(defaulted.limit, MESSAGE_DELIVERY_PAGE_SIZE);

  const full = listMessageDeliveriesRequestSchema.parse({
    state: "failed",
    kind: "operational_alert",
    recipient: "  operator@example.test  ",
    cursor: "opaque-cursor",
    limit: 5,
  });
  assert.equal(full.recipient, "operator@example.test");
  assert.equal(full.state, "failed");

  const invalid = [
    { limit: 0 },
    { limit: MESSAGE_DELIVERY_PAGE_SIZE + 1 },
    { limit: "many" },
    { state: "delivered" },
    { kind: "Not-A-Kind" },
    { recipient: "ab" },
    { recipient: "a".repeat(321) },
    { cursor: "" },
    // Unknown fields are refused, so nothing extra can ride into the queue
    // read — above all not a page-number or offset shape.
    { page: 2 },
    { offset: 40 },
  ];
  for (const request of invalid) {
    assert.equal(
      listMessageDeliveriesRequestSchema.safeParse(request).success,
      false,
      JSON.stringify(request),
    );
  }
});

test("detail and retry requests accept only an opaque intent UUID", () => {
  const intentId = "b6f6f4a0-3a89-4a90-8f6e-6a1d2c3b4a5f";
  assert.equal(
    messageDeliveryDetailRequestSchema.parse({ intentId }).intentId,
    intentId,
  );
  assert.equal(
    retryMessageDeliveryRequestSchema.parse({ intentId }).intentId,
    intentId,
  );
  for (const schema of [
    messageDeliveryDetailRequestSchema,
    retryMessageDeliveryRequestSchema,
  ]) {
    assert.equal(schema.safeParse({}).success, false);
    assert.equal(schema.safeParse({ intentId: "not-a-uuid" }).success, false);
    // A recipient address can never stand in for an intent identity.
    assert.equal(
      schema.safeParse({ intentId: "person@example.test" }).success,
      false,
    );
    assert.equal(
      schema.safeParse({ intentId, recipient: "person@example.test" }).success,
      false,
    );
  }
  assert.equal(messageDeliveryCountsRequestSchema.safeParse({}).success, true);
  assert.equal(
    messageDeliveryCountsRequestSchema.safeParse({ state: "failed" }).success,
    false,
  );
});

test("no row shape has a field a message body could travel in", () => {
  // Compile-time construction of both rows names every permitted field; a
  // body, subject, or rendered-content field cannot be expressed.
  const intent: MessageDeliveryIntentRow = {
    intentId: "b6f6f4a0-3a89-4a90-8f6e-6a1d2c3b4a5f",
    kind: "welcome",
    recipient: "person@example.test",
    source: "closed_beta",
    state: "failed",
    attemptCount: 3,
    createdAt: "2026-08-22T12:00:00.000Z",
    dueAt: "2026-08-22T12:00:00.000Z",
    lastAttemptedAt: "2026-08-22T12:05:00.000Z",
    lastProvider: "postmark",
    lastErrorCode: "PROVIDER_UNAVAILABLE",
    lastSkipReason: null,
    finalizedAt: "2026-08-22T12:05:00.000Z",
  };
  const attempt: MessageDeliveryAttemptRow = {
    attemptNumber: 1,
    attemptedAt: "2026-08-22T12:01:00.000Z",
    outcome: "failed",
    provider: "postmark",
    providerMessageId: null,
    errorCode: "PROVIDER_UNAVAILABLE",
    errorMessage: "The provider did not accept the message.",
    skipReason: null,
  };
  const contentFields = ["body", "textBody", "htmlBody", "subject", "input", "inputJson"];
  for (const field of contentFields) {
    assert.equal(field in intent, false, `intent row exposes ${field}`);
    assert.equal(field in attempt, false, `attempt row exposes ${field}`);
  }
});

test("every stable admin code is address-free and closed", () => {
  assert.equal(new Set(messageDeliveryAdminErrorCodes).size, messageDeliveryAdminErrorCodes.length);
  for (const code of messageDeliveryAdminErrorCodes) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/);
  }
});
