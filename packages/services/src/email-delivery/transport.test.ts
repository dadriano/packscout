import assert from "node:assert/strict";
import { test } from "node:test";
import { EMAIL_DELIVERY_ERROR_MESSAGE_MAX_LENGTH } from "@packscout/contracts";
import {
  EmailTransportTimeoutError,
  isRetryableEmailTransportStatus,
  normalizeEmailDeliveryErrorCode,
  sanitizeEmailProviderErrorText,
  withEmailTransportDeadline,
} from "./transport.ts";

test("the transport deadline bounds an unresponsive fetch and aborts the request", async () => {
  let observedSignal: AbortSignal | undefined;
  const hanging: typeof fetch = (_input, init) => {
    observedSignal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  };
  const bounded = withEmailTransportDeadline(hanging, 25);
  const started = Date.now();
  await assert.rejects(
    bounded("https://email-stub.invalid/messages"),
    (error) =>
      error instanceof EmailTransportTimeoutError &&
      error.code === "EMAIL_TRANSPORT_TIMEOUT",
  );
  assert.ok(Date.now() - started < 2_000, "the deadline must fire promptly");
  assert.equal(observedSignal?.aborted, true);
});

test("a responsive transport passes its response through inside the deadline", async () => {
  const bounded = withEmailTransportDeadline(
    async () => new Response("ok"),
    1_000,
  );
  const response = await bounded("https://email-stub.invalid/messages");
  assert.equal(await response.text(), "ok");
  for (const invalid of [0, -1, 1.5, 120_001, Number.NaN]) {
    assert.throws(() => withEmailTransportDeadline(fetch, invalid), RangeError);
  }
});

test("retryable transport statuses are timeout, rate limiting, and server errors only", () => {
  for (const retryable of [408, 429, 500, 502, 503, 599]) {
    assert.equal(isRetryableEmailTransportStatus(retryable), true, `${retryable}`);
  }
  for (const terminal of [200, 201, 301, 400, 401, 403, 404, 410, 422]) {
    assert.equal(isRetryableEmailTransportStatus(terminal), false, `${terminal}`);
  }
});

test("provider error text is sanitized, redacted, and length-bounded", () => {
  const raw = [
    "Upstream said: recipient operator@example.test refused\u0000\u0001",
    "authorization: Bearer sk-live-0123456789abcdefghijklmn",
    "cookie=session-0123456789abcdefghijklmnop",
    "trace 0xdeadbeefdeadbeef",
    "y".repeat(500),
  ].join(" ");
  const sanitized = sanitizeEmailProviderErrorText(raw);
  assert.ok(!sanitized.includes("operator@example.test"));
  assert.ok(!sanitized.includes("sk-live-0123456789abcdefghijklmn"));
  assert.ok(!sanitized.includes("session-0123456789abcdefghijklmnop"));
  assert.ok(!sanitized.includes("0xdeadbeefdeadbeef"));
  assert.ok(!sanitized.includes("\u0000"));
  assert.ok(sanitized.length <= EMAIL_DELIVERY_ERROR_MESSAGE_MAX_LENGTH);
  for (const withheld of [undefined, null, 7, {}, "", "   ", "\u0000\u0001"]) {
    assert.equal(
      sanitizeEmailProviderErrorText(withheld),
      "Provider error text withheld.",
    );
  }
});

test("error codes outside the stable alphabet fall back", () => {
  assert.equal(
    normalizeEmailDeliveryErrorCode("STUB_RATE_LIMITED", "EMAIL_PROVIDER_FAILED"),
    "STUB_RATE_LIMITED",
  );
  for (const invalid of ["lower", "", 9, undefined, "HAS SPACE"]) {
    assert.equal(
      normalizeEmailDeliveryErrorCode(invalid, "EMAIL_PROVIDER_FAILED"),
      "EMAIL_PROVIDER_FAILED",
    );
  }
});
