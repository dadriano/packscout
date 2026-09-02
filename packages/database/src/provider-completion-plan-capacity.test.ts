import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, readFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import {
  canonicalJson,
  MAX_PROVIDER_PROMOTION_AGGREGATE_PLAN_BYTES,
} from "@packscout/contracts";
import { z } from "zod";

const CHILD_MODE = "PACKSCOUT_PLAN_CAPACITY_CHILD";
const FIXTURE_PATH = "PACKSCOUT_PLAN_CAPACITY_FIXTURE";
const TEST_NAME = "near-cap plan materialization remains bounded";

async function writeNearCapFixture(path: string): Promise<void> {
  const output = createWriteStream(path, { flags: "wx" });
  let bytes = 0;
  const write = async (value: string) => {
    bytes += Buffer.byteLength(value, "utf8");
    if (!output.write(value)) await once(output, "drain");
  };
  await write('{"batches":[');
  for (let index = 0; ; index += 1) {
    const item = `${index === 0 ? "" : ","}${JSON.stringify({
      batchIndex: index,
      kind: "collectibles",
      records: [{
        id: String(index).padStart(12, "0"),
        name: `item-${index}-${"x".repeat(768)}`,
      }],
    })}`;
    if (
      bytes + Buffer.byteLength(item, "utf8") + 2 >
        MAX_PROVIDER_PROMOTION_AGGREGATE_PLAN_BYTES - 64 * 1_024
    ) break;
    await write(item);
  }
  await write("]}");
  output.end();
  await finished(output);
}

function runChild(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--max-old-space-size=256",
      "--import",
      "tsx",
      "--test",
      `--test-name-pattern=^${TEST_NAME}$`,
      fileURLToPath(import.meta.url),
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_TEST_CONTEXT: undefined,
        [CHILD_MODE]: "consume",
        [FIXTURE_PATH]: path,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (value: string) => {
      output += value;
    });
    child.stderr.setEncoding("utf8").on("data", (value: string) => {
      output += value;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(
        `Constrained plan child failed (${String(code ?? signal)}).\n${output}`,
      ));
    });
  });
}

test(TEST_NAME, { timeout: 120_000 }, async (context: TestContext) => {
  if (process.env[CHILD_MODE] !== "consume") {
    const directory = await mkdtemp(join(tmpdir(), "packscout-plan-capacity-"));
    const path = join(directory, "near-cap-plan.json");
    try {
      await writeNearCapFixture(path);
      const output = await runChild(path);
      const measurement = output.match(/near-cap plan bytes=[^\n]+/u)?.[0];
      assert.ok(measurement, output);
      context.diagnostic(measurement);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    return;
  }

  const path = process.env[FIXTURE_PATH];
  assert.ok(path);
  const fixtureBytes = (await stat(path)).size;
  assert.ok(fixtureBytes > MAX_PROVIDER_PROMOTION_AGGREGATE_PLAN_BYTES - 128 * 1_024);
  assert.ok(fixtureBytes <= MAX_PROVIDER_PROMOTION_AGGREGATE_PLAN_BYTES);
  const encoded = readFileSync(path);
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
  const parsed = JSON.parse(decoded) as unknown;
  const verified = z.object({
    batches: z.array(z.object({
      batchIndex: z.number().int().nonnegative(),
      kind: z.literal("collectibles"),
      records: z.array(z.object({ id: z.string(), name: z.string() })),
    })),
  }).parse(parsed);
  const recanonicalized = canonicalJson(verified);
  const persisted = Buffer.from(recanonicalized, "utf8");
  assert.equal(persisted.byteLength, fixtureBytes);
  assert.equal(verified.batches.length > 1_000, true);
  assert.equal(encoded.byteLength, persisted.byteLength);
  context.diagnostic(
    `near-cap plan bytes=${(fixtureBytes / 1_024 / 1_024).toFixed(2)} MiB; ` +
      `maxRSS=${(process.resourceUsage().maxRSS / 1_024).toFixed(1)} MiB`,
  );
});
