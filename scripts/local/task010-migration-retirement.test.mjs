import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Task010SafetyError, task010MigrationInvocation } from
  "./provider-source-task010-safety.mjs";

test("retired Task010 migration refuses before reading any invocation authority", () => {
  const input = new Proxy({}, { get() { throw new Error("authority was read"); } });
  assert.throws(() => task010MigrationInvocation(input), (error) =>
    error instanceof Task010SafetyError && error.code === "MIGRATION_WORKFLOW_RETIRED");
});

test("retired Task010 migration entrypoint has no database or process execution path", async () => {
  const source = await readFile(new URL("./migrate-provider-source-task010-target.mts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|task010-runtime|loadTask010EnvironmentFile|openTask010Database/u);
});

test("retired Task010 CLI returns a sanitized nonzero failure without loading authority", () => {
  const secret = "fixture-retired-migration-secret";
  const result = spawnSync(process.execPath, [
    "--import", import.meta.resolve("tsx"),
    fileURLToPath(new URL("./migrate-provider-source-task010-target.mts", import.meta.url)),
    "untrusted-argument",
  ], {
    env: { NODE_ENV: "production", PACKSCOUT_DATABASE_URL: `postgresql://test:${secret}@127.0.0.1:1/unused` },
    encoding: "utf8", timeout: 5_000, shell: false,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.ok, false);
  assert.equal(failure.code, "MIGRATION_WORKFLOW_RETIRED");
  assert.match(failure.error, /explicit target/u);
  assert.doesNotMatch(result.stderr, new RegExp(secret, "u"));
});
