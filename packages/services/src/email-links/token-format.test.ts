import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMAIL_LINK_SELECTOR_PATTERN,
  EMAIL_LINK_VERIFIER_PATTERN,
  emailLinkPresentedTokenSchema,
} from "@packscout/contracts";
import {
  createEmailLinkTokenSecurity,
  createEmailLinkVerifierDigest,
  generateEmailLinkToken,
  nodeEmailLinkRandomness,
  parsePresentedEmailLinkToken,
} from "./token-format.ts";

const secret = "an-email-link-test-secret-of-well-over-32-bytes";

test("generated tokens have the contract shape and fresh randomness each time", () => {
  const first = generateEmailLinkToken(nodeEmailLinkRandomness);
  const second = generateEmailLinkToken(nodeEmailLinkRandomness);
  for (const generated of [first, second]) {
    assert.ok(EMAIL_LINK_SELECTOR_PATTERN.test(generated.selector));
    assert.ok(EMAIL_LINK_VERIFIER_PATTERN.test(generated.verifier));
    assert.equal(
      generated.presented,
      `${generated.selector}.${generated.verifier}`,
    );
    assert.ok(emailLinkPresentedTokenSchema.safeParse(generated.presented).success);
  }
  assert.notEqual(first.selector, second.selector);
  assert.notEqual(first.verifier, second.verifier);
});

test("parsing accepts exactly the presented shape and nothing that only resembles it", () => {
  const generated = generateEmailLinkToken(nodeEmailLinkRandomness);
  assert.deepEqual(parsePresentedEmailLinkToken(generated.presented), {
    selector: generated.selector,
    verifier: generated.verifier,
  });
  for (const rejected of [
    undefined,
    null,
    42,
    "",
    generated.selector,
    generated.verifier,
    `${generated.selector}.${generated.verifier}.tail`,
    `${generated.selector}.${generated.verifier.slice(0, 42)}`,
    `${generated.selector}${generated.verifier}`,
    ` ${generated.presented}`,
    `${generated.presented.toUpperCase()}=`,
  ]) {
    assert.equal(parsePresentedEmailLinkToken(rejected), null);
  }
});

test("the verifier digest is purpose-separated, keyed, and never the verifier", () => {
  const digest = createEmailLinkVerifierDigest(secret);
  const otherKey = createEmailLinkVerifierDigest(`${secret}-other`);
  const { verifier } = generateEmailLinkToken(nodeEmailLinkRandomness);

  const stored = digest.digest("operator_password_reset", verifier);
  assert.notEqual(stored, verifier);
  assert.match(stored, /^[A-Za-z0-9_-]{43}$/);
  // Same verifier, different purpose: an unrelated digest.
  assert.notEqual(stored, digest.digest("operator_invitation", verifier));
  // Same purpose and verifier, different secret: an unrelated digest.
  assert.notEqual(stored, otherKey.digest("operator_password_reset", verifier));

  assert.equal(digest.matches("operator_password_reset", verifier, stored), true);
  assert.equal(digest.matches("operator_invitation", verifier, stored), false);
  assert.equal(
    digest.matches("operator_password_reset", `${verifier.slice(0, 42)}A`, stored),
    false,
  );
  // The stored digest itself is not a verifier: hashing it cannot match.
  assert.equal(digest.matches("operator_password_reset", stored, stored), false);
});

test("a short secret is refused before any token could be issued under it", () => {
  assert.throws(() => createEmailLinkVerifierDigest("short"), /32 bytes/);
  assert.throws(() => createEmailLinkTokenSecurity("short"), /32 bytes/);
});

test("bucket keys carry only HMAC material, scoped per purpose and per kind", () => {
  const security = createEmailLinkTokenSecurity(secret);
  const address = "operator@example.test";
  const source = "203.0.113.7";
  const addressKey = security.bucketKeyer.addressKey(
    "operator_password_reset",
    address,
  );
  const sourceKey = security.bucketKeyer.sourceKey(
    "operator_password_reset",
    source,
  );
  assert.match(addressKey, /^email_link:operator_password_reset:address:[A-Za-z0-9_-]{43}$/);
  assert.match(sourceKey, /^email_link:operator_password_reset:source:[A-Za-z0-9_-]{43}$/);
  assert.equal(addressKey.includes(address), false);
  assert.equal(sourceKey.includes(source), false);
  // Deterministic per input, distinct across purposes and kinds.
  assert.equal(
    addressKey,
    security.bucketKeyer.addressKey("operator_password_reset", address),
  );
  assert.notEqual(
    addressKey,
    security.bucketKeyer.addressKey("operator_invitation", address),
  );
  assert.notEqual(
    security.bucketKeyer.addressKey("operator_password_reset", "x@example.test"),
    security.bucketKeyer.sourceKey("operator_password_reset", "x@example.test"),
  );
});
