import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tsImport } from "tsx/esm/api";
const { readDatabaseRuntimePolicy } = await tsImport("@packscout/database", import.meta.url);
const { parsePausedHeadArguments, assertPausedHeadEnvironment, assertNoPausedHeadWriter, readPausedHeadReview } =
  await tsImport("./provider-paused-head-resume.mts", import.meta.url);
const { pausedHeadReviewSchema } = await tsImport("./provider-paused-head-policy.mts", import.meta.url);
const { pins } = await import("./provider-resident-test-fixture.mjs");
function review() {
  return pausedHeadReviewSchema.parse({ version: 1, authorization: "operator_requested_paused_head_resume", pins,
    previousOperationId: "3a333333-3333-4333-8333-333333333335", previousOperationReceiptDigest: "a".repeat(64),
    sourceCommit: "b".repeat(40), migrationProofPath: "/synthetic/migration.json", migrationProofDigest: "c".repeat(64),
    central: { host: "central.example.test", port: 5432, databaseName: "packscout", sslMode: "verify-full" },
    provider: { host: "provider.example.test", port: 5432, databaseName: "packscout_clutchpacks", sslMode: "verify-full" },
    authorityDigest: "d".repeat(64), configNumber: "4", pauseCommandId: "4a333333-3333-4333-8333-333333333335",
    pauseCommandDigest: "e".repeat(64), generation: "32", runtimeRowVersion: "130", importFence: "481",
    checkpointHash: "f".repeat(64), parentDigest: "1".repeat(64), headProofDigest: "2".repeat(64) });
}
const remote = { NODE_ENV: "development", PACKSCOUT_DATABASE_MODE: "remote",
  PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS: "central.example.test", PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS: "provider.example.test" };
function environment(query = "sslmode=require&sslaccept=strict") {
  return { centralDatabaseUrl: `postgresql://synthetic:synthetic@central.example.test/packscout?${query}`,
    runtimePolicy: readDatabaseRuntimePolicy(remote) };
}
test("reviewed remote central identity accepts native strict TLS with implicit 5432 and verify-full", () => {
  for (const query of ["sslmode=require&sslaccept=strict", "sslmode=verify-full", "sslmode=verify-full&sslaccept=strict"]) {
    assert.doesNotThrow(() => assertPausedHeadEnvironment(review(), environment(query)));
  }
});
test("CLI rejects ambiguous or weaker TLS, wrong authority/database and local runtime mode", () => {
  for (const query of ["", "sslmode=require", "sslmode=disable", "sslmode=verify-ca", "sslmode=verify-full&sslaccept=accept_invalid_certs",
    "sslmode=verify-full&sslmode=require", "sslmode=require&sslaccept=strict&sslaccept=strict",
    "sslmode=require&sslaccept=strict&hostaddr=127.0.0.1", "sslmode=require&sslaccept=strict&host=/tmp"]) {
    assert.throws(() => assertPausedHeadEnvironment(review(), environment(query)));
  }
  for (const change of [x => { x.centralDatabaseUrl = x.centralDatabaseUrl.replace("central.example.test", "other.example.test"); },
    x => { x.centralDatabaseUrl = x.centralDatabaseUrl.replace("/packscout?", "/postgres?"); },
    x => { x.centralDatabaseUrl = x.centralDatabaseUrl.replace("central.example.test/", "central.example.test:55431/"); },
    x => { x.runtimePolicy = readDatabaseRuntimePolicy({ NODE_ENV: "development" }); }]) {
    const env = environment(); change(env); assert.throws(() => assertPausedHeadEnvironment(review(), env));
  }
  assert.throws(() => assertPausedHeadEnvironment({ ...review(), provider: { ...review().provider, host: "other.example.test" } }, environment()));
});
test("check-only and digest-pinned apply are the only CLI actions", () => {
  assert.deepEqual(parsePausedHeadArguments(["--review-file", "/private/review.json", "--check-only"]), { file: "/private/review.json", digest: null });
  assert.equal(parsePausedHeadArguments(["--review-file", "/private/review.json", "--apply", "--review-digest", "a".repeat(64)]).digest, "a".repeat(64));
  for (const args of [[], ["--review-file", "relative.json", "--check-only"], ["--review-file", "/private/review.json", "--apply"],
    ["--review-file", "/private/review.json", "--check-only", "--apply"], ["--review-file", "/private/review.json", "--run"]]) {
    assert.throws(() => parsePausedHeadArguments(args), /PAUSED_HEAD_ARGUMENTS_INVALID/);
  }
});
test("exclusive process guard detects importer, generic worker, source supervisor, poller and real promotion entry", () => {
  for (const script of ["scripts/local/promote-distributed-clutchpacks-to-local-convex.mts", "apps/worker/src/provider-manual-import-local.ts",
    "apps/worker/src/clutchpacks-manual-import-local.ts", "apps/worker/src/source-supervisor-local.ts", "apps/worker/src/index.ts", "src/index.ts",
    "scripts/local/run-provider-continuous-poller.mts", "scripts/local/run-provider-backfill-supervisor.mts",
    "scripts/local/start-provider-source-task010-supervisor.mts"]) {
    assert.throws(() => assertNoPausedHeadWriter(`123 1 /usr/bin/node --import tsx ${script} --run`, 999), /PAUSED_HEAD_WRITER_PRESENT/);
    assert.doesNotThrow(() => assertNoPausedHeadWriter(`123 1 /usr/bin/node --import tsx ${script} --check-only`, 999));
  }
  assert.doesNotThrow(() => assertNoPausedHeadWriter("123 1 /usr/bin/node scripts/local/provider-paused-head-resume.mts --apply\n124 1 next-server", 123));
  assert.throws(() => assertNoPausedHeadWriter("unparseable process inventory"), /PAUSED_HEAD_PROCESS_INVENTORY_INVALID/);
});
test("private approval file reader refuses symlinks, public permissions, oversized and unrecognized content", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "packscout-paused-head-test-"));
  try {
    const file = path.join(directory, "review.json"), link = path.join(directory, "link.json");
    await writeFile(file, JSON.stringify(review()), { mode: 0o600 });
    assert.deepEqual(await readPausedHeadReview(file), review());
    await symlink(file, link); await assert.rejects(readPausedHeadReview(link));
    await chmod(file, 0o644); await assert.rejects(readPausedHeadReview(file), /PAUSED_HEAD_PRIVATE_FILE_INVALID/);
    await chmod(file, 0o600); await writeFile(file, "x".repeat(16385)); await assert.rejects(readPausedHeadReview(file), /PAUSED_HEAD_PRIVATE_FILE_INVALID/);
    await writeFile(file, JSON.stringify({ ...review(), rawCursor: "synthetic-unapproved-field" })); await assert.rejects(readPausedHeadReview(file));
  } finally { await rm(directory, { force: true, recursive: true }); }
});
