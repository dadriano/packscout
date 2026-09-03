import assert from "node:assert/strict";
import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const {
  DATAFOREST_PAGE_PROBE_BOUNDS,
  DATAFOREST_PAGE_PROBE_PLATFORMS,
  DATAFOREST_PAGE_PROBE_TARGETS,
  assertNoPageProbeArguments,
  loadLocalProbeEnvironment,
  probeDataforestPageLimits,
} = await tsImport("./probe-dataforest-page-limits.mts", import.meta.url);
const { HardenedProviderRequestError } = await tsImport(
  "../../packages/services/src/index.ts",
  import.meta.url,
);

const TEST_TOKEN = "unit-test-probe-token-never-print";

function page(platform, count) {
  return {
    records: Array.from({ length: count }, () => ({ platform })),
    next_cursor: "private-cursor-never-print",
    poll_after_seconds: 0,
  };
}

function captureFor(resolver) {
  let active = 0;
  let maximumActive = 0;
  const calls = [];
  return {
    calls,
    get maximumActive() {
      return maximumActive;
    },
    capture: async (input) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        calls.push(input);
        return await resolver(input);
      } finally {
        active -= 1;
      }
    },
  };
}

test("page-limit probe fixes its request matrix and rejects caller arguments", () => {
  assert.deepEqual(DATAFOREST_PAGE_PROBE_TARGETS, [500, 1_000, 2_500]);
  assert.deepEqual(DATAFOREST_PAGE_PROBE_PLATFORMS, [
    "courtyard",
    "collector_crypt",
    "phygitals",
    "clutchpacks",
  ]);
  assert.deepEqual(DATAFOREST_PAGE_PROBE_BOUNDS, {
    maximumRequests: 12,
    maximumResponseBytesPerRequest: 8_388_608,
    maximumResponseBytesTotal: 100_663_296,
    requestTimeoutMilliseconds: 10_000,
    maximumWallClockMilliseconds: 125_000,
    concurrency: 1,
  });
  assert.doesNotThrow(() => assertNoPageProbeArguments([]));
  assert.throws(
    () => assertNoPageProbeArguments(["--token", TEST_TOKEN]),
    /local safety check/u,
  );
});

test("page-limit probe performs only sequential initial reads and emits no protected values", async () => {
  const harness = captureFor(async (input) => {
    const platform = input.url.searchParams.get("platform");
    const limit = Number(input.url.searchParams.get("limit"));
    const protectedBody = new TextEncoder().encode(
      JSON.stringify(page(platform, limit)),
    );
    await new Promise((resolve) => setTimeout(resolve, 1));
    return {
      status: 200,
      protectedBody,
      durationMilliseconds: limit / 10,
      responseBytes: protectedBody.byteLength,
    };
  });
  const report = await probeDataforestPageLimits({
    bearerToken: TEST_TOKEN,
    capture: harness.capture,
  });

  assert.equal(harness.calls.length, 12);
  assert.equal(harness.maximumActive, 1);
  assert.equal(report.largestViableTarget, 2_500);
  assert.ok(report.measurements.every(({ outcome }) => outcome === "safe"));
  for (const call of harness.calls) {
    assert.equal(call.url.origin + call.url.pathname,
      "https://198.204.245.26.sslip.io/v1/events");
    assert.equal(call.url.searchParams.has("cursor"), false);
    assert.equal(call.timeoutMilliseconds, 10_000);
    assert.equal(call.maximumResponseBytes, 8_388_608);
    assert.equal(call.headers.authorization, `Bearer ${TEST_TOKEN}`);
  }

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, new RegExp(TEST_TOKEN, "u"));
  assert.doesNotMatch(serialized, /authorization|Bearer|private-cursor/u);
  assert.doesNotMatch(serialized, /record_id|next_cursor|configuration/u);
});

test("page-limit probe recommends only a target safe for every platform", async () => {
  const harness = captureFor(async (input) => {
    const platform = input.url.searchParams.get("platform");
    const limit = Number(input.url.searchParams.get("limit"));
    if (platform === "phygitals" && limit === 2_500) {
      throw new HardenedProviderRequestError(
        "response_too_large",
        undefined,
        321,
      );
    }
    const protectedBody = new TextEncoder().encode(
      JSON.stringify(page(platform, limit)),
    );
    return {
      status: 200,
      protectedBody,
      durationMilliseconds: 10,
      responseBytes: protectedBody.byteLength,
    };
  });
  const report = await probeDataforestPageLimits({
    bearerToken: TEST_TOKEN,
    capture: harness.capture,
  });
  assert.equal(report.largestViableTarget, 1_000);
  assert.deepEqual(
    report.measurements.find(
      ({ platform, requestedRecords }) =>
        platform === "phygitals" && requestedRecords === 2_500,
    ),
    {
      platform: "phygitals",
      requestedRecords: 2_500,
      returnedRecords: null,
      responseBytes: null,
      latencyMs: 321,
      outcome: "response_too_large",
    },
  );
});

test("short and cross-platform pages cannot certify a target", async () => {
  const harness = captureFor(async (input) => {
    const platform = input.url.searchParams.get("platform");
    const limit = Number(input.url.searchParams.get("limit"));
    const body = platform === "courtyard" && limit === 2_500
      ? page(platform, 2_499)
      : platform === "clutchpacks" && limit === 1_000
        ? page("courtyard", limit)
        : page(platform, limit);
    const protectedBody = new TextEncoder().encode(JSON.stringify(body));
    return {
      status: 200,
      protectedBody,
      durationMilliseconds: 10,
      responseBytes: protectedBody.byteLength,
    };
  });
  const report = await probeDataforestPageLimits({
    bearerToken: TEST_TOKEN,
    capture: harness.capture,
  });
  assert.equal(report.largestViableTarget, 500);
  assert.equal(
    report.measurements.find(
      ({ platform, requestedRecords }) =>
        platform === "courtyard" && requestedRecords === 2_500,
    ).outcome,
    "short_page",
  );
  assert.equal(
    report.measurements.find(
      ({ platform, requestedRecords }) =>
        platform === "clutchpacks" && requestedRecords === 1_000,
    ).outcome,
    "wrong_platform",
  );
});

test("runtime environment loader accepts only the owned fixed symlink target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "packscout-page-probe-"));
  const target = path.join(root, "runtime.env");
  const link = path.join(root, "requested.env");
  const key = Buffer.alloc(32, 7).toString("base64");
  await writeFile(target, [
    "PACKSCOUT_DATABASE_URL=postgresql://packscout:packscout@127.0.0.1:5432/packscout_test",
    "PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION=1",
    `PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64=${key}`,
    "PACKSCOUT_SOURCE_DATABASE_VOLUME_PATH=/tmp/packscout-test-volume",
    `PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64=${key}`,
    "",
  ].join("\n"), { mode: 0o600 });
  await symlink(target, link);

  const loaded = await loadLocalProbeEnvironment({
    requestedPath: link,
    expectedRealpath: await realpath(target),
  });
  assert.equal(loaded.databaseUrl.includes("packscout_test"), true);
  assert.equal(loaded.sourceConnectionKey.byteLength, 32);
  assert.equal(loaded.sourceConnectionKeyVersion, 1);
  await assert.rejects(
    loadLocalProbeEnvironment({
      requestedPath: target,
      expectedRealpath: target,
    }),
    /local safety check/u,
  );
});
