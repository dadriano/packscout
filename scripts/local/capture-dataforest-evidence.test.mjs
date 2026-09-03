import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DATAFOREST_CAPTURE_DEFAULTS,
  DATAFOREST_CAPTURE_MAX_BYTES,
  DATAFOREST_ENDPOINT,
  DATAFOREST_PLATFORM_FILTERS,
  captureDataforestEvidence,
  parseCaptureOptions,
  readBoundedResponseBody,
  readDataforestToken,
  runCaptureCli,
  summarizeJsonStructure,
} from "./capture-dataforest-evidence.mjs";

const TEST_TOKEN = "unit-test-bearer-token-never-print";
const PRIVATE_VALUES = [
  TEST_TOKEN,
  "private-record-id",
  "private-cursor",
  "private-transaction",
  "private-wallet",
  "private-username",
  "private-provider-value",
  "private-error-detail",
];

function jsonResponse(value, status = 200) {
  const body = JSON.stringify(value);
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    },
  });
}

function pageFor(platform, pageNumber) {
  return {
    records: [
      {
        record_id: `private-record-id:${platform}:${pageNumber}`,
        platform,
        stream: "private-provider-value",
        event_type: "private-provider-value",
        transaction_hash: "private-transaction",
        wallet: "private-wallet",
        username: "private-username",
        available: null,
        payment_method: null,
        data: {
          nested_private_value: "private-provider-value",
          nullable_field: null,
        },
      },
    ],
    next_cursor: `private-cursor:${platform}:${pageNumber + 1}`,
    poll_after_seconds: 0,
  };
}

function createDataforestMock({ delayMs = 3 } = {}) {
  const calls = [];
  let active = 0;
  let maximumActive = 0;

  const fetchImpl = async (input, init) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const url = new URL(input);
      const authorization = new Headers(init.headers).get("authorization");
      calls.push({
        url,
        method: init.method,
        authorization,
        redirect: init.redirect,
      });

      if (!authorization) {
        return jsonResponse({ error: "private-error-detail" }, 401);
      }
      if (authorization !== `Bearer ${TEST_TOKEN}`) {
        return jsonResponse({ error: "private-error-detail" }, 403);
      }

      const platform = url.searchParams.get("platform");
      const cursor = url.searchParams.get("cursor");
      if (platform === "__packscout_unknown__") {
        return jsonResponse({ error: "private-error-detail" }, 422);
      }
      if (cursor === "packscout-malformed-cursor") {
        return jsonResponse({ error: "private-error-detail" }, 400);
      }
      if (cursor?.startsWith("private-cursor:")) {
        const [, cursorPlatform, page] = cursor.split(":");
        if (platform !== cursorPlatform) {
          return jsonResponse({ error: "private-error-detail" }, 400);
        }
        return jsonResponse(pageFor(platform, Number(page)));
      }
      return jsonResponse(pageFor(platform ?? "courtyard", 1));
    } finally {
      active -= 1;
    }
  };

  return {
    fetchImpl,
    calls,
    get maximumActive() {
      return maximumActive;
    },
  };
}

test("parseCaptureOptions uses approved defaults and only accepts stricter bounds", () => {
  assert.deepEqual(parseCaptureOptions([]), {
    help: false,
    options: DATAFOREST_CAPTURE_DEFAULTS,
  });
  assert.deepEqual(
    parseCaptureOptions([
      "--limit",
      "25",
      "--max-bytes",
      "4096",
      "--timeout-ms",
      "500",
      "--concurrency",
      "4",
    ]),
    {
      help: false,
      options: {
        limit: 25,
        maxBytes: 4096,
        timeoutMs: 500,
        concurrency: 4,
      },
    },
  );
  assert.equal(
    parseCaptureOptions(["--max-bytes", "8388608"]).options.maxBytes,
    DATAFOREST_CAPTURE_MAX_BYTES,
  );

  for (const argumentsList of [
    ["--limit", "501"],
    ["--max-bytes", "8388609"],
    ["--timeout-ms", "10001"],
    ["--concurrency", "1"],
    ["--endpoint", "https://example.test"],
    ["--token", TEST_TOKEN],
  ]) {
    assert.throws(() => parseCaptureOptions(argumentsList));
  }
});

test("readDataforestToken rejects missing, padded, and control-bearing values", () => {
  assert.equal(
    readDataforestToken({ PACKSCOUT_DATA_API_TOKEN: TEST_TOKEN }),
    TEST_TOKEN,
  );
  for (const value of [undefined, "", " padded", "padded ", "line\nbreak"]) {
    assert.throws(
      () => readDataforestToken({ PACKSCOUT_DATA_API_TOKEN: value }),
      /PACKSCOUT_DATA_API_TOKEN/,
    );
  }
});

test("summarizeJsonStructure preserves schema but not primitive values", () => {
  const summary = summarizeJsonStructure({
    records: [
      {
        record_id: "private-record-id",
        available: null,
        data: { wallet: "private-wallet", amount: 12.5 },
      },
    ],
  });
  const serialized = JSON.stringify(summary);
  assert.match(serialized, /\$\.records\[\]\.record_id/);
  assert.match(serialized, /\$\.records\[\]\.available/);
  assert.match(serialized, /\$\.records\[\]\.data\.wallet/);
  assert.match(serialized, /"nulls":1/);
  assert.doesNotMatch(serialized, /private-record-id|private-wallet|12\.5/);
});

test("readBoundedResponseBody rejects advertised and streamed overflow", async () => {
  const advertised = new Response("ignored", {
    headers: { "content-length": "100" },
  });
  const advertisedResult = await readBoundedResponseBody(advertised, 10);
  assert.equal(advertisedResult.exceeded, true);
  assert.equal(advertisedResult.buffer, null);

  const streamed = new Response("0123456789ABCDEF");
  const streamedResult = await readBoundedResponseBody(streamed, 10);
  assert.equal(streamedResult.exceeded, true);
  assert.equal(streamedResult.buffer, null);
});

test("captureDataforestEvidence executes the fixed bounded probe matrix without leaking values", async () => {
  const mock = createDataforestMock();
  const report = await captureDataforestEvidence({
    token: TEST_TOKEN,
    fetchImpl: mock.fetchImpl,
    now: () => new Date("2026-08-20T12:00:00.000Z"),
  });

  assert.equal(report.capturedAt, "2026-08-20T12:00:00.000Z");
  assert.equal(report.endpoint.host, "198.204.245.26.sslip.io");
  assert.equal(report.endpoint.path, "/v1/events");
  assert.equal(report.bounds.recordsPerFilteredRequest, 500);
  assert.equal(report.bounds.maximumResponseBytes, DATAFOREST_CAPTURE_MAX_BYTES);
  assert.equal(report.bounds.requestTimeoutMs, 10_000);
  assert.equal(report.bounds.parallelRequestCount, 2);
  assert.equal(report.bounds.actualRequestCount, 22);
  assert.equal(mock.calls.length, 22);
  assert.equal(mock.maximumActive, 2);

  assert.deepEqual(
    report.platforms.map((entry) => entry.filter),
    DATAFOREST_PLATFORM_FILTERS,
  );
  for (const platform of report.platforms) {
    assert.equal(platform.initial.response.status, 200);
    assert.equal(platform.continuation.response.status, 200);
    assert.equal(platform.sameCursorReplay.response.status, 200);
    assert.equal(
      platform.initial.response.page.filterIsolation.mismatchingRecords,
      0,
    );
    assert.equal(platform.replayComparison.sameInputCursor, true);
    assert.equal(platform.replayComparison.bodyHashEqual, true);
    assert.equal(platform.replayComparison.structureHashEqual, true);
    assert.equal(
      platform.replayComparison.recordIdentity.exactSequenceEqual,
      true,
    );
  }

  assert.equal(report.profileProbe.request.limit, null);
  assert.equal(report.negativeProbes.unauthorized.response.status, 401);
  assert.equal(report.negativeProbes.unknownFilter.response.status, 422);
  assert.equal(report.negativeProbes.malformedCursor.response.status, 400);
  assert.equal(report.negativeProbes.crossFilterCursor.length, 4);
  assert.ok(
    report.negativeProbes.crossFilterCursor.every(
      (probe) => probe.response.status === 400,
    ),
  );
  assert.equal(report.parallelProbe.requestedConcurrency, 2);
  assert.equal(report.parallelProbe.maximumClientInFlightRequests, 2);
  assert.equal(report.parallelProbe.clientOverlapObserved, true);
  assert.equal(report.parallelProbe.allSuccessful, true);
  assert.equal(report.parallelProbe.allFilterCorrect, true);
  assert.equal(report.parallelProbe.cursorsIndependent, true);

  const profileCall = mock.calls[0];
  assert.equal(profileCall.url.href, DATAFOREST_ENDPOINT);
  assert.equal(profileCall.method, "GET");
  assert.equal(profileCall.redirect, "error");
  assert.equal(profileCall.authorization, `Bearer ${TEST_TOKEN}`);
  assert.equal(
    mock.calls.filter((call) => call.authorization === null).length,
    1,
  );
  for (const filter of DATAFOREST_PLATFORM_FILTERS) {
    const cursorRequests = mock.calls.filter(
      (call) =>
        call.url.searchParams.get("platform") === filter &&
        call.url.searchParams.get("cursor")?.includes(filter),
    );
    assert.equal(cursorRequests.length, 2);
  }

  const serialized = JSON.stringify(report);
  for (const privateValue of PRIVATE_VALUES) {
    assert.doesNotMatch(serialized, new RegExp(privateValue, "u"));
  }
  assert.doesNotMatch(serialized, /bodySha256|body_sha256/u);
  assert.doesNotMatch(serialized, /Bearer /u);
});

test("capture records response-limit failures without retaining a body", async () => {
  const fetchImpl = async () =>
    new Response("x", {
      status: 200,
      headers: { "content-length": "200" },
    });
  const report = await captureDataforestEvidence({
    token: TEST_TOKEN,
    fetchImpl,
    maxBytes: 100,
  });
  assert.equal(report.profileProbe.response.outcome, "response_too_large");
  assert.equal(
    Object.hasOwn(report.profileProbe.response, "bodySha256"),
    false,
  );
  assert.equal(report.bounds.actualRequestCount, 10);
  assert.ok(
    report.platforms.every(
      (platform) =>
        platform.continuation.response.outcome === "skipped" &&
        platform.sameCursorReplay.response.outcome === "skipped",
    ),
  );
});

test("capture classifies timeouts without exposing thrown fetch details", async () => {
  const fetchImpl = (_input, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => reject(new Error("private-error-detail")),
        { once: true },
      );
    });
  const report = await captureDataforestEvidence({
    token: TEST_TOKEN,
    fetchImpl,
    timeoutMs: 1,
  });
  assert.equal(report.profileProbe.response.outcome, "timeout");
  assert.equal(report.profileProbe.response.statusClass, "client_timeout");
  assert.doesNotMatch(JSON.stringify(report), /private-error-detail/);
});

test("runCaptureCli reads the token from env, clears the process copy, and prints sanitized JSON", async () => {
  const mock = createDataforestMock({ delayMs: 0 });
  const previous = process.env.PACKSCOUT_DATA_API_TOKEN;
  process.env.PACKSCOUT_DATA_API_TOKEN = TEST_TOKEN;
  let output = "";
  try {
    await runCaptureCli({
      argumentsList: ["--limit", "10"],
      environment: process.env,
      fetchImpl: mock.fetchImpl,
      write: (value) => {
        output += value;
      },
    });
    assert.equal(process.env.PACKSCOUT_DATA_API_TOKEN, undefined);
  } finally {
    if (previous === undefined) delete process.env.PACKSCOUT_DATA_API_TOKEN;
    else process.env.PACKSCOUT_DATA_API_TOKEN = previous;
  }

  const report = JSON.parse(output);
  assert.equal(report.bounds.recordsPerFilteredRequest, 10);
  for (const privateValue of PRIVATE_VALUES) {
    assert.doesNotMatch(output, new RegExp(privateValue, "u"));
  }
});

test("runCaptureCli help makes no request and does not require a token", async () => {
  let output = "";
  let called = false;
  await runCaptureCli({
    argumentsList: ["--help"],
    environment: {},
    fetchImpl: async () => {
      called = true;
      throw new Error("must not run");
    },
    write: (value) => {
      output += value;
    },
  });
  assert.equal(called, false);
  assert.match(output, /PACKSCOUT_DATA_API_TOKEN/);
  assert.match(output, /endpoint is fixed/i);
});
