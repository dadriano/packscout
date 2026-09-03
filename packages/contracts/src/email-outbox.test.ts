import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMAIL_MESSAGE_INTENT_TERMINAL_STATES,
  EMAIL_OUTBOX_INPUT_MAX_JSON_LENGTH,
  emailMessageAttemptOutcomeSchema,
  emailMessageAttemptSkipReasonSchema,
  emailMessageIntentStateSchema,
  emailOutboxIdempotencyKeySchema,
  emailOutboxSourceSchema,
  isTerminalEmailMessageIntentState,
} from "./email-outbox.ts";

test("intent lifecycle is exactly pending, retrying, sent, skipped, failed", () => {
  assert.deepEqual(emailMessageIntentStateSchema.options, [
    "pending",
    "retrying",
    "sent",
    "skipped",
    "failed",
  ]);
  assert.equal(emailMessageIntentStateSchema.safeParse("queued").success, false);
  assert.equal(emailMessageIntentStateSchema.safeParse("running").success, false);
});

test("terminal states are sent, skipped, and failed; live states are not terminal", () => {
  assert.deepEqual([...EMAIL_MESSAGE_INTENT_TERMINAL_STATES], [
    "sent",
    "skipped",
    "failed",
  ]);
  for (const state of EMAIL_MESSAGE_INTENT_TERMINAL_STATES) {
    assert.equal(isTerminalEmailMessageIntentState(state), true);
  }
  assert.equal(isTerminalEmailMessageIntentState("pending"), false);
  assert.equal(isTerminalEmailMessageIntentState("retrying"), false);
});

test("attempt outcomes reuse the delivery result vocabulary and skip reasons", () => {
  assert.deepEqual(emailMessageAttemptOutcomeSchema.options, [
    "sent",
    "skipped",
    "failed",
  ]);
  for (const reason of [
    "delivery_disabled",
    "console_mode",
    "missing_configuration",
  ]) {
    assert.equal(
      emailMessageAttemptSkipReasonSchema.safeParse(reason).success,
      true,
    );
  }
  assert.equal(
    emailMessageAttemptSkipReasonSchema.safeParse("retrying").success,
    false,
  );
});

test("sources share the message-kind alphabet and stay bounded", () => {
  assert.equal(emailOutboxSourceSchema.safeParse("operational_alerts").success, true);
  assert.equal(emailOutboxSourceSchema.safeParse("closed_beta").success, true);
  for (const invalid of ["Operational Alerts", "_leading", "x".repeat(65), ""]) {
    assert.equal(emailOutboxSourceSchema.safeParse(invalid).success, false);
  }
});

test("idempotency keys allow event-derived identities and refuse unbounded or unsafe values", () => {
  for (const valid of [
    "alert:7f3f8a94-9d3e-4d6f-8a2b-1f2e3d4c5b6a:window:2026-08-22",
    "welcome:did.privy_abc123",
    "a",
  ]) {
    assert.equal(emailOutboxIdempotencyKeySchema.safeParse(valid).success, true);
  }
  for (const invalid of ["", ":leading", "has space", "x".repeat(257)]) {
    assert.equal(
      emailOutboxIdempotencyKeySchema.safeParse(invalid).success,
      false,
    );
  }
});

test("stored rendering inputs are bounded when serialized", () => {
  assert.equal(EMAIL_OUTBOX_INPUT_MAX_JSON_LENGTH, 16_384);
});
