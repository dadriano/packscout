import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMAIL_MESSAGE_BOUNDS_EXCEEDED_ERROR_CODE,
  EMAIL_MESSAGE_INPUT_INVALID_ERROR_CODE,
  EMAIL_MESSAGE_LINK_PATH_MAX_LENGTH,
  absoluteEmailMessageLink,
  escapeEmailHtml,
  finalizeRenderedEmailMessage,
  formatEmailInstantUtc,
  normalizeEmailMessageProse,
  unsafeEmailMessageContent,
} from "./rendering.ts";

test("every HTML-significant character is escaped", () => {
  assert.equal(
    escapeEmailHtml(`<a href="x" onload='y'>Fish & Chips</a>`),
    "&lt;a href=&quot;x&quot; onload=&#39;y&#39;&gt;Fish &amp; Chips&lt;/a&gt;",
  );
});

test("prose normalization collapses whitespace and refuses invalid values", () => {
  assert.equal(normalizeEmailMessageProse("  a\n b\t\tc  ", 100), "a b c");
  assert.equal(normalizeEmailMessageProse("", 100), null);
  assert.equal(normalizeEmailMessageProse("   \n ", 100), null);
  assert.equal(normalizeEmailMessageProse("abc\u0007def", 100), null);
  assert.equal(normalizeEmailMessageProse("abc\u0000def", 100), null);
  assert.equal(normalizeEmailMessageProse("abc\u009Fdef", 100), null);
  assert.equal(normalizeEmailMessageProse("a".repeat(101), 100), null);
  assert.equal(normalizeEmailMessageProse(42, 100), null);
  assert.equal(normalizeEmailMessageProse(undefined, 100), null);
});

test("credential-shaped content is detected in prose values", () => {
  for (const unsafe of [
    "Authorization: Bearer abc123",
    "sent with bearer header",
    "the session cookie was rejected",
    "operator password was rejected",
    "client secret: rotate it",
    "secret=value",
    "failed with 0xdeadbeefdeadbeef",
    "token = abc",
    "token:abc",
    "the api_key is invalid",
    "an api-key was refused",
    "blob deadbeefdeadbeefdeadbeefdeadbeef present",
    "jwt eyJhbGciOiJIUzI1NiJ9 seen",
    `run ${"A1b2C3d4".repeat(5)} observed`,
  ]) {
    assert.equal(
      unsafeEmailMessageContent(unsafe),
      true,
      `expected refusal for ${JSON.stringify(unsafe)}`,
    );
  }
});

test("ordinary operational prose is not refused", () => {
  for (const safe of [
    "Provider imports failing for GameStop",
    "Three consecutive runs failed before any page completed.",
    "Evidence: RUN_TIMEOUT, PROVIDER_STALE",
    "token rotation completed upstream",
    "secretive scheduling behavior observed",
    "Dana Reyes",
  ]) {
    assert.equal(
      unsafeEmailMessageContent(safe),
      false,
      `expected acceptance for ${JSON.stringify(safe)}`,
    );
  }
});

test("instants render deterministically in UTC", () => {
  assert.equal(
    formatEmailInstantUtc("2026-08-20T14:03:00.000Z"),
    "20 Aug 2026, 14:03 UTC",
  );
  assert.equal(
    formatEmailInstantUtc("2026-01-05T09:30:00+02:00"),
    "5 Jan 2026, 07:30 UTC",
  );
  assert.equal(formatEmailInstantUtc("not a time"), null);
  assert.equal(formatEmailInstantUtc(""), null);
  assert.equal(formatEmailInstantUtc(1_755_600_000_000), null);
});

test("absolute links are built only from rooted, clean paths", () => {
  assert.equal(
    absoluteEmailMessageLink("https://admin.packscout.io", "/alerts/abc?x=1"),
    "https://admin.packscout.io/alerts/abc?x=1",
  );
  for (const rejected of [
    "alerts/abc",
    "//evil.example/alerts",
    "https://evil.example/alerts",
    "/alerts/a b",
    "/alerts\\abc",
    "/alerts/tab\there",
    "/alerts/<script>",
    '/alerts/"quoted"',
    "/alerts/'quoted'",
    "/alerts/`tick`",
    "",
    `/${"a".repeat(EMAIL_MESSAGE_LINK_PATH_MAX_LENGTH)}`,
    42,
  ]) {
    assert.equal(
      absoluteEmailMessageLink("https://admin.packscout.io", rejected),
      null,
      `expected rejection for ${JSON.stringify(rejected)}`,
    );
  }
});

const validCandidate = {
  kind: "welcome",
  toEmail: "person@example.com",
  subject: "Welcome to PackScout",
  textBody: "Welcome.",
  htmlBody: "<p>Welcome.</p>",
};

test("the final gate accepts a candidate satisfying the delivery contract", () => {
  const result = finalizeRenderedEmailMessage(validCandidate);
  assert.ok(result.status === "rendered");
  assert.deepEqual(result.message, validCandidate);
});

test("the final gate reports bound violations explicitly", () => {
  for (const oversized of [
    { ...validCandidate, subject: "s".repeat(201) },
    { ...validCandidate, textBody: "t".repeat(100_001) },
    { ...validCandidate, htmlBody: "h".repeat(500_001) },
  ]) {
    const result = finalizeRenderedEmailMessage(oversized);
    assert.ok(result.status === "failed");
    assert.equal(result.errorCode, EMAIL_MESSAGE_BOUNDS_EXCEEDED_ERROR_CODE);
  }
});

test("the final gate reports invalid values explicitly", () => {
  for (const invalid of [
    { ...validCandidate, toEmail: "not-an-address" },
    { ...validCandidate, kind: "Not A Kind" },
    { ...validCandidate, subject: "   " },
    { ...validCandidate, textBody: "" },
  ]) {
    const result = finalizeRenderedEmailMessage(invalid);
    assert.ok(result.status === "failed");
    assert.equal(result.errorCode, EMAIL_MESSAGE_INPUT_INVALID_ERROR_CODE);
  }
});
