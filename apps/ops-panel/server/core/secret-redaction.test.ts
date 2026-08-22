import assert from "node:assert/strict";
import { test } from "node:test";
import { describeRedactedError, redactSecrets } from "./secret-redaction.ts";

test("a known secret is removed wherever it appears", () => {
  const secret = "postgresql://packscout:hunter2@127.0.0.1:5432/packscout_dev";
  const redacted = redactSecrets(
    `could not connect to ${secret} (twice: ${secret})`,
    [secret],
  );
  assert.ok(!redacted.includes("hunter2"));
  assert.equal(redacted.match(/\[redacted\]/gu)?.length, 2);
});

test("user info is stripped from a connection string the panel never knew", () => {
  const redacted = redactSecrets(
    'FATAL: password authentication failed, url postgresql://someone:s3cret@db.example.com:5432/app',
  );
  assert.ok(!redacted.includes("s3cret"));
  assert.ok(!redacted.includes("someone"));
  assert.ok(redacted.includes("db.example.com"));
});

test("key-value credentials are stripped from libpq-style text", () => {
  const redacted = redactSecrets("host=127.0.0.1 password=hunter2 dbname=packscout");
  assert.equal(redacted, "host=127.0.0.1 password=[redacted] dbname=packscout");
});

test("non-string and empty input can never become a disclosure", () => {
  assert.equal(redactSecrets(undefined), "");
  assert.equal(redactSecrets(null, ["x"]), "");
  assert.equal(redactSecrets(""), "");
  assert.equal(redactSecrets("text", [undefined, "", "   "]), "text");
});

test("an error is described in one redacted line", () => {
  const secret = "postgresql://packscout:hunter2@127.0.0.1:5432/packscout_dev";
  assert.match(
    describeRedactedError(new Error(`connect ECONNREFUSED using ${secret}`), [secret]),
    /ECONNREFUSED using \[redacted\]/u,
  );
  assert.equal(describeRedactedError(new Error("")), "No further detail is available.");
  assert.equal(describeRedactedError("plain failure"), "plain failure");
});
