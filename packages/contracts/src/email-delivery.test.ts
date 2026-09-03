import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMAIL_DELIVERY_ERROR_MESSAGE_MAX_LENGTH,
  EMAIL_PROVIDER_MESSAGE_ID_MAX_LENGTH,
  emailDeliveryErrorCodeSchema,
  emailDeliverySkipReasonSchema,
  emailMessageKindSchema,
  emailProviderNameSchema,
  renderedEmailMessageSchema,
} from "./email-delivery.ts";

const message = {
  kind: "operational_alert",
  toEmail: "operator@example.test",
  subject: "A provider import failed",
  textBody: "The provider import stopped.",
  htmlBody: "<p>The provider import stopped.</p>",
};

test("a rendered email message carries kind, recipient, subject, and both bodies", () => {
  assert.deepEqual(renderedEmailMessageSchema.parse(message), message);
  assert.equal(
    renderedEmailMessageSchema.safeParse({ ...message, extra: "field" }).success,
    false,
  );
  assert.equal(
    renderedEmailMessageSchema.parse({
      ...message,
      toEmail: "  operator@example.test  ",
    }).toEmail,
    "operator@example.test",
  );
});

test("rendered messages refuse invalid kinds, recipients, and unbounded content", () => {
  for (const invalid of [
    { ...message, kind: "Operational Alert" },
    { ...message, kind: "x".repeat(65) },
    { ...message, toEmail: "not-an-address" },
    { ...message, toEmail: `${"a".repeat(320)}@example.test` },
    { ...message, subject: "   " },
    { ...message, subject: "s".repeat(201) },
    { ...message, textBody: "" },
    { ...message, textBody: "t".repeat(100_001) },
    { ...message, htmlBody: "" },
    { ...message, htmlBody: "h".repeat(500_001) },
  ]) {
    assert.equal(renderedEmailMessageSchema.safeParse(invalid).success, false);
  }
});

test("skip reasons are a closed vocabulary", () => {
  assert.deepEqual(emailDeliverySkipReasonSchema.options, [
    "delivery_disabled",
    "console_mode",
    "missing_configuration",
  ]);
  assert.equal(emailDeliverySkipReasonSchema.safeParse("bounced").success, false);
});

test("provider names and message kinds share bounded identifier alphabets", () => {
  assert.equal(emailProviderNameSchema.safeParse("postmark").success, true);
  assert.equal(emailProviderNameSchema.safeParse("email-stub").success, true);
  for (const invalid of ["", "-leading", "trailing-", "Has Upper", "a".repeat(65)]) {
    assert.equal(emailProviderNameSchema.safeParse(invalid).success, false);
  }
  assert.equal(emailMessageKindSchema.safeParse("welcome_first_sign_in").success, true);
  assert.equal(emailMessageKindSchema.safeParse("9starts_numeric").success, false);
});

test("delivery error codes reuse the operational stable-code alphabet", () => {
  assert.equal(
    emailDeliveryErrorCodeSchema.safeParse("EMAIL_DELIVERY_TIMEOUT").success,
    true,
  );
  for (const invalid of ["lowercase", "HAS SPACE", "", "9LEADING", "A".repeat(129)]) {
    assert.equal(emailDeliveryErrorCodeSchema.safeParse(invalid).success, false);
  }
});

test("boundary length limits stay positive and bounded", () => {
  assert.equal(EMAIL_DELIVERY_ERROR_MESSAGE_MAX_LENGTH, 200);
  assert.equal(EMAIL_PROVIDER_MESSAGE_ID_MAX_LENGTH, 256);
});
