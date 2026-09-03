import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_LEDGER_ARTIFACT_PATH,
  assertLoopbackDatabaseUrl,
  parseBackfillArguments,
  sha256Hex,
} from "./backfill-buyback-ev.mjs";

const ORGANIZATION = "42000000-0000-4000-8000-000000000001";
const READ_AT = "2026-08-18T02:00:00.000Z";

test("backfill arguments parse with strict validation", () => {
  const parsed = parseBackfillArguments([
    "--organization",
    ORGANIZATION,
    "--read-at",
    READ_AT,
  ]);
  assert.equal(parsed.organizationId, ORGANIZATION);
  assert.equal(parsed.readAt, READ_AT);
  assert.equal(parsed.outPath, DEFAULT_LEDGER_ARTIFACT_PATH);
  assert.equal(parsed.evidenceModule, null);
  assert.equal(parsed.gatedAt, null);

  assert.throws(
    () => parseBackfillArguments(["--read-at", READ_AT]),
    /--organization/,
  );
  assert.throws(
    () =>
      parseBackfillArguments([
        "--organization",
        "NOT-A-UUID",
        "--read-at",
        READ_AT,
      ]),
    /--organization/,
  );
  assert.throws(
    () =>
      parseBackfillArguments([
        "--organization",
        ORGANIZATION,
        "--read-at",
        "2026-08-18",
      ]),
    /--read-at/,
  );
  assert.throws(
    () =>
      parseBackfillArguments([
        "--organization",
        ORGANIZATION,
        "--read-at",
        READ_AT,
        "--application-commit",
        "not-a-sha!",
      ]),
    /--application-commit/,
  );
  assert.throws(
    () =>
      parseBackfillArguments([
        "--organization",
        ORGANIZATION,
        "--read-at",
        READ_AT,
        "--gated-at",
        READ_AT,
      ]),
    /--gated-at and --reopened-at/,
  );
  assert.throws(
    () =>
      parseBackfillArguments([
        "--organization",
        ORGANIZATION,
        "--read-at",
        READ_AT,
        "--unknown",
        "x",
      ]),
    /Unknown backfill option/,
  );
});

test("the database host must be loopback and PostgreSQL", () => {
  for (const url of [
    "postgresql://user@127.0.0.1:5432/packscout",
    "postgres://user@localhost:5432/packscout",
  ]) {
    assert.equal(assertLoopbackDatabaseUrl(url), url);
  }
  assert.throws(() => assertLoopbackDatabaseUrl(undefined), /required/);
  assert.throws(() => assertLoopbackDatabaseUrl("not a url"), /valid URL/);
  assert.throws(
    () => assertLoopbackDatabaseUrl("mysql://127.0.0.1/db"),
    /PostgreSQL/,
  );
  assert.throws(
    () => assertLoopbackDatabaseUrl("postgresql://db.internal.example:5432/x"),
    /non-loopback/,
  );
});

test("the ledger artifact path stays inside the gitignored evidence directory", () => {
  assert.equal(
    DEFAULT_LEDGER_ARTIFACT_PATH,
    "docs/evidence/buyback-adjusted-ev-readiness-ledger.json",
  );
  assert.match(sha256Hex("packscout"), /^[0-9a-f]{64}$/);
});
