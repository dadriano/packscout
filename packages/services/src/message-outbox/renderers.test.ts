import assert from "node:assert/strict";
import { test } from "node:test";
import { CATALOGUE_EMAIL_MESSAGE_KINDS } from "../message-catalogue/catalogue.ts";
import { createEmailMessageOutboxRenderers } from "./renderers.ts";

const origins = {
  productOrigin: "https://packscout.example",
  adminOrigin: "https://admin.packscout.example",
};

test("the outbox renders exactly the catalogue's kinds, one renderer each", () => {
  const renderers = createEmailMessageOutboxRenderers();
  assert.deepEqual(
    Object.keys(renderers).sort(),
    [...CATALOGUE_EMAIL_MESSAGE_KINDS].sort(),
  );
  assert.equal(Object.isFrozen(renderers), true);
});

test("a stored input renders through the catalogue into a deliverable message", () => {
  const renderers = createEmailMessageOutboxRenderers();
  const result = renderers.welcome!(
    { toEmail: "admitted@example.test" },
    origins,
  );
  assert.equal(result.status, "rendered");
  if (result.status === "rendered") {
    assert.equal(result.message.kind, "welcome");
    assert.equal(result.message.toEmail, "admitted@example.test");
    assert.equal(result.message.subject, "Welcome to PackScout");
  }
});

test("the direct operator account renderer uses the fixed sign-in link and refuses credential fields", () => {
  const renderers = createEmailMessageOutboxRenderers();
  const rendered = renderers.operator_account_created!(
    { toEmail: "created@example.test" },
    origins,
  );
  assert.equal(rendered.status, "rendered");
  if (rendered.status === "rendered") {
    assert.equal(rendered.message.kind, "operator_account_created");
    assert.match(
      rendered.message.textBody,
      /https:\/\/admin\.packscout\.example\/login/,
    );
    assert.match(rendered.message.textBody, /separate secure channel/);
  }

  for (const input of [
    { toEmail: "created@example.test", initialPassword: "not-for-storage" },
    { toEmail: "created@example.test", passwordHash: "not-for-storage" },
  ]) {
    const refused = renderers.operator_account_created!(input, origins);
    assert.equal(refused.status, "failed");
    if (refused.status === "failed") {
      assert.equal(refused.errorCode, "EMAIL_MESSAGE_INPUT_INVALID");
      assert.doesNotMatch(refused.reason, /not-for-storage/);
    }
  }
});

test("malformed stored JSON becomes an explicit render failure, never a throw", () => {
  const renderers = createEmailMessageOutboxRenderers();
  for (const junk of [
    { toEmail: "operator@example.test", severity: "loud" },
    { toEmail: "operator@example.test" },
    {},
    { toEmail: 42 },
  ]) {
    const result = renderers.operational_alert!(junk, origins);
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.errorCode, "EMAIL_MESSAGE_INPUT_INVALID");
    }
  }
});

test("a missing configured origin is an explicit failure for link-bearing kinds", () => {
  const renderers = createEmailMessageOutboxRenderers();
  const result = renderers.welcome!(
    { toEmail: "admitted@example.test" },
    { productOrigin: null, adminOrigin: null },
  );
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.errorCode, "EMAIL_MESSAGE_ORIGIN_MISSING");
  }
});
