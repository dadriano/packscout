import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMAIL_LINK_PRESENTED_TOKEN_LENGTH,
  EMAIL_LINK_PURPOSES,
  EMAIL_LINK_SELECTOR_PATTERN,
  EMAIL_LINK_VERIFIER_HASH_PATTERN,
  EMAIL_LINK_VERIFIER_PATTERN,
  emailLinkPresentedTokenSchema,
  emailLinkPurposeSchema,
} from "./email-links.ts";

const selector = "a".repeat(22);
const verifier = "B".repeat(43);

test("the purposes are exactly operator password reset and operator invitation", () => {
  assert.deepEqual(emailLinkPurposeSchema.options, [
    "operator_password_reset",
    "operator_invitation",
  ]);
  assert.deepEqual([...EMAIL_LINK_PURPOSES], emailLinkPurposeSchema.options);
  assert.ok(Object.isFrozen(EMAIL_LINK_PURPOSES));
  assert.equal(emailLinkPurposeSchema.safeParse("session").success, false);
  assert.equal(emailLinkPurposeSchema.safeParse("").success, false);
});

test("selector and verifier patterns pin the base64url alphabet and exact lengths", () => {
  assert.ok(EMAIL_LINK_SELECTOR_PATTERN.test(selector));
  assert.ok(EMAIL_LINK_SELECTOR_PATTERN.test("Aa0_-Aa0_-Aa0_-Aa0_-Aa"));
  assert.equal(EMAIL_LINK_SELECTOR_PATTERN.test("a".repeat(21)), false);
  assert.equal(EMAIL_LINK_SELECTOR_PATTERN.test("a".repeat(23)), false);
  assert.equal(EMAIL_LINK_SELECTOR_PATTERN.test(`${"a".repeat(21)}+`), false);

  assert.ok(EMAIL_LINK_VERIFIER_PATTERN.test(verifier));
  assert.equal(EMAIL_LINK_VERIFIER_PATTERN.test("B".repeat(42)), false);
  assert.equal(EMAIL_LINK_VERIFIER_PATTERN.test("B".repeat(44)), false);
  assert.equal(EMAIL_LINK_VERIFIER_PATTERN.test(`${"B".repeat(42)}=`), false);

  // The stored hash shares the verifier's shape: 32 digest bytes as base64url.
  assert.ok(EMAIL_LINK_VERIFIER_HASH_PATTERN.test(verifier));
});

test("a presented token is exactly selector dot verifier and nothing else", () => {
  const presented = `${selector}.${verifier}`;
  assert.equal(presented.length, EMAIL_LINK_PRESENTED_TOKEN_LENGTH);
  assert.ok(emailLinkPresentedTokenSchema.safeParse(presented).success);

  for (const rejected of [
    "",
    selector,
    verifier,
    `${selector}.${verifier}.extra`,
    `${selector}:${verifier}`,
    `${selector}.${"B".repeat(42)}`,
    `${"a".repeat(21)}.${verifier}`,
    ` ${selector}.${verifier}`,
    `${selector}.${verifier} `,
    `${selector}.${"B".repeat(42)}=`,
  ]) {
    assert.equal(
      emailLinkPresentedTokenSchema.safeParse(rejected).success,
      false,
      `expected rejection: ${JSON.stringify(rejected.slice(0, 8))}...`,
    );
  }
});
