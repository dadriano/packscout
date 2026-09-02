import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tsImport } from "tsx/esm/api";
import { failedHeadFixture } from "./provider-failed-head-test-fixture.mjs";
const { readFailedHeadReview, parseFailedHeadArguments } = await tsImport("./provider-failed-head-resume.mts", import.meta.url);
const { failedHeadReviewSchema } = await tsImport("./provider-failed-head-policy.mts", import.meta.url);
test("failed-head review requires precise audit sequences, independent operation and explicit operator authorization", async () => {
  const { review } = await failedHeadFixture();
  for (const patch of [{ authorization: "automatic" }, { parentCommandDigest: undefined }, { sourceCommit: "main" },
    { rawCursor: "unreviewed" }, { generation: "9223372036854775807" }, { checkpointHash: null },
    { pins: { ...review.pins, operationId: review.priorOperationId } },
    { provenance: { ...review.provenance, cycle: { id: review.pins.initialRunId, digest: "a".repeat(64) } } },
    { provenance: { ...review.provenance, cycle: review.provenance.operation } }]) {
    assert.equal(failedHeadReviewSchema.safeParse({ ...review, ...patch }).success, false);
  }
  assert.equal(parseFailedHeadArguments(["--review-file", "/private/review.json", "--check-only"]).digest, null);
  assert.throws(() => parseFailedHeadArguments(["--review-file", "/private/review.json", "--apply"]));
});
test("failed-head CLI shares private owner-only no-symlink bounded approval admission", async () => {
  const { review } = await failedHeadFixture(), directory = await mkdtemp(path.join(os.tmpdir(), "packscout-failed-head-test-"));
  try {
    const file = path.join(directory, "review.json"), link = path.join(directory, "link.json");
    await writeFile(file, JSON.stringify(review), { mode: 0o600 }); assert.deepEqual(await readFailedHeadReview(file), review);
    await symlink(file, link); await assert.rejects(readFailedHeadReview(link));
    await chmod(file, 0o644); await assert.rejects(readFailedHeadReview(file));
    await chmod(file, 0o600); await writeFile(file, "x".repeat(24577)); await assert.rejects(readFailedHeadReview(file));
  } finally { await rm(directory, { force: true, recursive: true }); }
});
