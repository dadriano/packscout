import assert from "node:assert/strict";
import { test } from "node:test";
import { runPromotionObservabilityFanout } from "./promotion-observability-fanout.ts";

test("throwing promotion loggers cannot suppress durable readiness", async () => {
  let durableCalls = 0;
  await assert.rejects(
    runPromotionObservabilityFanout(
      () => {
        durableCalls += 1;
      },
      () => {
        throw new Error("logger unavailable");
      },
    ),
    /logger unavailable/u,
  );
  assert.equal(durableCalls, 1);
});

test("durable readiness failures cannot suppress best-effort logging", async () => {
  let logCalls = 0;
  await assert.rejects(
    runPromotionObservabilityFanout(
      () => {
        throw new Error("durable readiness unavailable");
      },
      () => {
        logCalls += 1;
      },
    ),
    /durable readiness unavailable/u,
  );
  assert.equal(logCalls, 1);
});

test("durable readiness errors take precedence when both sinks fail", async () => {
  await assert.rejects(
    runPromotionObservabilityFanout(
      () => {
        throw new Error("durable failure");
      },
      () => {
        throw new Error("logging failure");
      },
    ),
    /durable failure/u,
  );
});
