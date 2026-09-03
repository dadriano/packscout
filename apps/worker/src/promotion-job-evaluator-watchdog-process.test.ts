import assert from "node:assert/strict";
import test from "node:test";
import type {
  PromotionJobEvaluatorWatchdogResponse,
} from "@packscout/services";
import {
  runPromotionJobEvaluatorWatchdogProcess,
} from "./promotion-job-evaluator-watchdog-process.ts";

function response(
  health: PromotionJobEvaluatorWatchdogResponse["health"],
): PromotionJobEvaluatorWatchdogResponse {
  return {
    lifecycle: "active",
    health,
    evaluatorEpoch: "1",
    missedWindowCount: health === "alerting" ? "3" : "0",
    evaluatedAt: "2026-09-01T12:03:00.001Z",
    lastSuccessfulEvaluationAt: "2026-09-01T12:00:00.000Z",
    evaluatedThrough: "2026-09-01T12:00:00.000Z",
    rosterDigest: "a".repeat(64),
    expectedCount: 3,
    reachableCount: 2,
    unavailableCount: 1,
  };
}

function output() {
  const values: string[] = [];
  return { values, port: { write(value: string) { values.push(value); } } };
}

test("healthy watchdog delivers externally, emits only the safe response, and exits zero", async () => {
  const events: string[] = [];
  const stdout = output();
  const stderr = output();
  const observed = response("healthy");
  const exitCode = await runPromotionJobEvaluatorWatchdogProcess({
    database: {
      async start() { events.push("start"); },
      async close() { events.push("close"); },
    },
    boundary: { async inspect() { events.push("inspect"); return observed; } },
    systemConditionSink: {
      async publishEvaluatorObservation(value) {
        assert.equal(value, observed);
        events.push("publish");
        return { state: "delivered" };
      },
    },
    stdout: stdout.port,
    stderr: stderr.port,
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(events, ["start", "inspect", "publish", "close"]);
  assert.deepEqual(stdout.values, [`${JSON.stringify(observed)}\n`]);
  assert.deepEqual(stderr.values, []);
});

test("proved alerting exits nonzero after external delivery", async () => {
  const observed = response("alerting");
  const exitCode = await runPromotionJobEvaluatorWatchdogProcess({
    database: { async start() {}, async close() {} },
    boundary: { async inspect() { return observed; } },
    systemConditionSink: {
      async publishEvaluatorObservation() { return { state: "delivered" }; },
    },
    stdout: output().port,
    stderr: output().port,
  });
  assert.equal(exitCode, 2);
});

test("unavailable evidence or external delivery exits one with redacted failure", async () => {
  for (const failure of ["inspect", "sink"] as const) {
    let closed = false;
    const stdout = output();
    const stderr = output();
    const exitCode = await runPromotionJobEvaluatorWatchdogProcess({
      database: {
        async start() {},
        async close() { closed = true; },
      },
      boundary: {
        async inspect() {
          if (failure === "inspect") {
            throw new Error("postgresql://secret@provider.example/private");
          }
          return response("healthy");
        },
      },
      systemConditionSink: {
        async publishEvaluatorObservation() {
          return {
            state: "retryable_failure",
            failureCode: "RAW_UPSTREAM_SECRET",
          };
        },
      },
      stdout: stdout.port,
      stderr: stderr.port,
    });
    assert.equal(exitCode, 1);
    assert.equal(closed, true);
    const rendered = stderr.values.join("");
    assert.match(rendered, /WATCHDOG_(?:SYSTEM_SINK_)?UNAVAILABLE/u);
    assert.doesNotMatch(rendered, /postgres|secret|provider|database|upstream/iu);
  }
});
